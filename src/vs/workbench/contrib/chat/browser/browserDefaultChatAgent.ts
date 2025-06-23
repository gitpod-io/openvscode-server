/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWeb } from '../../../../base/common/platform.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService, IChatAgentData } from '../common/chatAgents.js';
import { IChatProgress, IChatTextEdit, IChatNotebookEdit } from '../common/chatService.js';
import { ChatAgentLocation, ChatMode, ChatConfiguration } from '../common/constants.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { asText, isSuccess } from '../../../../platform/request/common/request.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/path.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ChatContextKeys } from '../common/chatContextKeys.js';
import { TextEdit } from '../../../../editor/common/languages.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ICellEditOperation } from '../../notebook/common/notebookCommon.js';

/**
 * Context key for Agent Mode (Tools Agent) - matches setup agent pattern
 */
const ToolsAgentContextKey = ContextKeyExpr.and(
	ContextKeyExpr.equals(`config.${ChatConfiguration.AgentEnabled}`, true),
	ChatContextKeys.Editing.agentModeDisallowed.negate(),
	ContextKeyExpr.not(`previewFeaturesDisabled`) // Set by extension
);

/**
 * Configuration interface for local Claude proxy server
 */
interface LocalServerConfig {
	baseUrl: string;
	enabled: boolean;
}

/**
 * Local server request/response interfaces
 */
interface LocalServerRequest {
	message: string;
	context?: ContextInfo;
}

interface LocalServerResponse {
	content?: string;
	error?: string;
	fileEdits?: Array<{
		uri: string;
		edits: Array<{
			range: {
				startLineNumber: number;
				startColumn: number;
				endLineNumber: number;
				endColumn: number;
			};
			text: string;
		}>;
	}>;
	notebookEdits?: Array<{
		uri: string;
		cellOperations: ICellEditOperation[];
	}>;
}

/**
 * Context information gathered from the workspace
 */
interface ContextInfo {
	activeFile?: {
		name: string;
		path: string;
		content: string;
		language: string;
	};
	selection?: {
		text: string;
		startLine: number;
		endLine: number;
	};
	openFiles?: Array<{
		name: string;
		path: string;
		language: string;
	}>;
	attachedFiles?: Array<{
		name: string;
		content: string;
		path: string;
		range?: {
			startLine: number;
			endLine: number;
		};
		isImage?: boolean;
	}>;
}

/**
 * Browser-compatible default chat agent that provides basic functionality
 * when running VS Code in a web browser environment
 */
export class BrowserDefaultChatAgent extends Disposable implements IChatAgentImplementation {

	private readonly serverConfig: LocalServerConfig; constructor(
		@ILogService private readonly logService: ILogService,
		@IRequestService private readonly requestService: IRequestService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextFileService private readonly textFileService: ITextFileService
	) {
		super();
		this.logService.info('[BrowserDefaultChatAgent] Browser default chat agent initialized');

		// Initialize local server configuration
		this.serverConfig = {
			baseUrl: this.configurationService.getValue<string>('chat.claude.baseUrl') || 'http://localhost:3001',
			enabled: true
		};
	}	/**
	 * Gathers context information from the current workspace
	 */
	private async gatherContextInfo(request: IChatAgentRequest): Promise<ContextInfo> {
		const context: ContextInfo = {};

		try {
			// Get active editor and its content
			const activeEditor = this.editorService.activeTextEditorControl;
			if (activeEditor && isCodeEditor(activeEditor)) {
				const model = activeEditor.getModel();
				if (model) {
					const uri = model.uri;
					const selection = activeEditor.getSelection();

					context.activeFile = {
						name: basename(uri.path),
						path: uri.toString(),
						content: model.getValue(),
						language: model.getLanguageId()
					};
					// Get selected text if any
					if (selection && !selection.isEmpty()) {
						const selectedText = model.getValueInRange(selection);
						const startLine = selection.startLineNumber;
						const endLine = selection.endLineNumber;

						this.logService.info('[BrowserDefaultChatAgent] Found selection:', {
							startLine,
							endLine,
							hasText: !!selectedText,
							textLength: selectedText?.length || 0
						});

						context.selection = {
							text: selectedText,
							startLine: startLine,
							endLine: endLine
						};
					}
				}
			}

			// Get list of open files
			const openEditors = this.editorService.visibleTextEditorControls;
			context.openFiles = [];

			for (const editor of openEditors) {
				if (isCodeEditor(editor)) {
					const model = editor.getModel();
					if (model) {
						const uri = model.uri;
						context.openFiles.push({
							name: basename(uri.path),
							path: uri.toString(),
							language: model.getLanguageId()
						});
					}
				}
			}

			// Process attached context from the request variables
			if (request.variables && Array.isArray(request.variables.variables)) {
				context.attachedFiles = [];

				for (const variable of request.variables.variables) {
					try {
						if (variable.kind === 'file' && variable.value) {
							// Handle file attachments (can be URI or Location with range)
							let fileUri: URI;
							let range: { startLine: number; endLine: number } | undefined;

							if (URI.isUri(variable.value)) {
								fileUri = variable.value;
							} else if (typeof variable.value === 'object' && 'uri' in variable.value) {
								fileUri = variable.value.uri as URI;
								if ('range' in variable.value && variable.value.range) {
									const r = variable.value.range as any;
									range = {
										startLine: r.startLineNumber || r.start?.line || 1,
										endLine: r.endLineNumber || r.end?.line || 1
									};
								}
							} else {
								continue;
							}

							const fileContent = await this.textFileService.read(fileUri);
							let content = fileContent.value;

							// If a range is specified, extract only that portion
							if (range) {
								const lines = content.split('\n');
								const startLine = Math.max(0, range.startLine - 1);
								const endLine = Math.min(lines.length - 1, range.endLine - 1);
								content = lines.slice(startLine, endLine + 1).join('\n');
							}

							context.attachedFiles.push({
								name: variable.name || basename(fileUri.path),
								path: fileUri.toString(),
								content: content,
								range: range
							});
						} else if (variable.kind === 'paste') {
							// Handle pasted content
							if (variable.value && typeof variable.value === 'object') {
								const pasteData = variable.value as any;
								if ('code' in pasteData || 'text' in pasteData) {
									context.attachedFiles.push({
										name: variable.name || 'Pasted Content',
										path: 'paste://',
										content: pasteData.code || pasteData.text || String(variable.value),
										range: pasteData.range ? {
											startLine: pasteData.range.startLineNumber || 1,
											endLine: pasteData.range.endLineNumber || 1
										} : undefined
									});
								}
							} else if (typeof variable.value === 'string') {
								// Handle direct string values
								context.attachedFiles.push({
									name: variable.name || 'Pasted Content',
									path: 'paste://',
									content: variable.value
								});
							}

						} else if (variable.kind === 'generic' && variable.value) {
							// Handle generic context (symbols, etc.)
							if (typeof variable.value === 'object' && 'uri' in variable.value) {
								const genericData = variable.value as any;
								const fileUri = genericData.uri as URI;
								const fileContent = await this.textFileService.read(fileUri);

								let content = fileContent.value;
								let range: { startLine: number; endLine: number } | undefined;

								if ('range' in genericData && genericData.range) {
									const r = genericData.range;
									range = {
										startLine: r.startLineNumber || r.start?.line || 1,
										endLine: r.endLineNumber || r.end?.line || 1
									};

									// Extract the specific range
									const lines = content.split('\n');
									const startLine = Math.max(0, range.startLine - 1);
									const endLine = Math.min(lines.length - 1, range.endLine - 1);
									content = lines.slice(startLine, endLine + 1).join('\n');
								}

								context.attachedFiles.push({
									name: variable.name || basename(fileUri.path),
									path: fileUri.toString(),
									content: content,
									range: range
								});
							}

						} else if (variable.kind === 'image' && variable.value) {
							// Handle image attachments (just metadata for now)
							context.attachedFiles.push({
								name: variable.name || 'Image',
								path: variable.value.toString(),
								content: `[Image: ${variable.name}]`,
								isImage: true
							});
						}

					} catch (error) {
						this.logService.warn('[BrowserDefaultChatAgent] Failed to process attached variable:', variable, error);
					}
				}
			}

		} catch (error) {
			this.logService.error('[BrowserDefaultChatAgent] Error gathering context:', error);
		}

		return context;
	}
	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: any[],
		token: CancellationToken
	): Promise<IChatAgentResult> {
		this.logService.info('[BrowserDefaultChatAgent] Processing request:', request.message);

		// Check if local server is available
		if (!this.serverConfig.enabled) {
			this.logService.warn('[BrowserDefaultChatAgent] Local server disabled, falling back to static responses');
			return this.handleStaticResponse(request, progress, token);
		}

		// Report progress
		progress([{
			kind: 'markdownContent',
			content: new MarkdownString('_Gathering context and connecting to local Claude server..._')
		}]);

		try {
			const userMessage = request.message.trim();			// Gather context information from the workspace
			const context = await this.gatherContextInfo(request);
			this.logService.info('[BrowserDefaultChatAgent] Gathered context:', {
				hasActiveFile: !!context.activeFile,
				hasSelection: !!context.selection,
				selectionData: context.selection ? {
					startLine: context.selection.startLine,
					endLine: context.selection.endLine,
					textLength: context.selection.text?.length || 0
				} : null,
				openFilesCount: context.openFiles?.length || 0,
				attachedFilesCount: context.attachedFiles?.length || 0
			});

			await this.sendLocalServerRequest(userMessage, context, progress, token);

			return { metadata: { command: 'claude-chat' } };

		} catch (error) {
			this.logService.error('[BrowserDefaultChatAgent] Error processing local server request:', error);

			// Fall back to static response on error
			this.logService.info('[BrowserDefaultChatAgent] Falling back to static response due to error');
			return this.handleStaticResponse(request, progress, token);
		}
	} private async sendLocalServerRequest(
		userMessage: string,
		context: ContextInfo,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken
	): Promise<void> {		// Prepare the local server request (matching your curl format)
		const serverRequest: LocalServerRequest = {
			message: userMessage,
			context: context
		};

		this.logService.info('[BrowserDefaultChatAgent] Sending request to server:', {
			message: userMessage,
			contextSummary: {
				hasActiveFile: !!context.activeFile,
				hasSelection: !!context.selection,
				selectionDetails: context.selection
			}
		});

		// Make the request to your local server
		const response = await this.requestService.request({
			type: 'POST',
			url: `${this.serverConfig.baseUrl}/ai/claude/agent`,
			data: JSON.stringify(serverRequest),
			headers: {
				'Content-Type': 'application/json'
			}
		}, token);

		if (!isSuccess(response)) {
			throw new Error(`Local server request failed with status ${response.res.statusCode}`);
		}

		// Handle response from your local server
		await this.processLocalServerResponse(response, progress, token);
	}
	private async processLocalServerResponse(
		response: any,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken
	): Promise<void> {
		const responseText = await asText(response);

		if (!responseText) {
			throw new Error('Empty response from local server');
		}

		try {
			const serverResponse: LocalServerResponse = JSON.parse(responseText);

			if (serverResponse.error) {
				throw new Error(`Server error: ${serverResponse.error}`);
			}

			this.logService.info('[BrowserDefaultChatAgent] Received response from local server:', serverResponse);

			// Process file edits if present
			if (serverResponse.fileEdits && serverResponse.fileEdits.length > 0) {
				await this.processFileEdits(serverResponse.fileEdits, progress, token);
			}

			// Process notebook edits if present
			if (serverResponse.notebookEdits && serverResponse.notebookEdits.length > 0) {
				await this.processNotebookEdits(serverResponse.notebookEdits, progress, token);
			}

			// Process regular content
			const content = serverResponse.content || 'No response received from server.';
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(content)
			}]);

		} catch (parseError) {
			this.logService.error('[BrowserDefaultChatAgent] Failed to parse server response:', parseError);

			// Try to use the raw response text as fallback
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(responseText || 'Unable to parse server response.')
			}]);
		}
	}

	private async handleStaticResponse(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken
	): Promise<IChatAgentResult> {
		// Report progress
		progress([{
			kind: 'markdownContent',
			content: new MarkdownString('_Processing your request..._')
		}]);

		try {
			const userMessage = request.message.trim();

			// Provide helpful responses based on common queries
			let responseContent = '';

			if (userMessage.toLowerCase().includes('help') || userMessage.toLowerCase().includes('what can you do')) {
				responseContent = this.getHelpResponse();
			} else if (userMessage.toLowerCase().includes('extension') || userMessage.toLowerCase().includes('install')) {
				responseContent = this.getExtensionResponse();
			} else if (userMessage.toLowerCase().includes('browser') || userMessage.toLowerCase().includes('web')) {
				responseContent = this.getBrowserResponse();
			} else if (userMessage.toLowerCase().includes('code') || userMessage.toLowerCase().includes('programming')) {
				responseContent = this.getCodeResponse();
			} else if (userMessage.toLowerCase().includes('settings') || userMessage.toLowerCase().includes('config')) {
				responseContent = this.getSettingsResponse();
			} else {
				responseContent = this.getDefaultResponse(userMessage);
			}

			// Report the final response
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(responseContent)
			}]);

			return { metadata: { command: 'help' } };

		} catch (error) {
			this.logService.error('[BrowserDefaultChatAgent] Error processing static request:', error);

			progress([{
				kind: 'markdownContent',
				content: new MarkdownString('❌ Sorry, I encountered an error while processing your request. Please try again.')
			}]);

			return { errorDetails: { message: String(error) } };
		}
	} private async processFileEdits(
		fileEdits: Array<{ uri: string; edits: Array<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; }; text: string; }> }>, progress: (parts: IChatProgress[]) => void, token: CancellationToken
	): Promise<void> {
		this.logService.info('[BrowserDefaultChatAgent] Processing file edits:', fileEdits.length);

		for (const fileEdit of fileEdits) {
			if (token.isCancellationRequested) {
				break;
			}

			try {
				const uri = URI.parse(fileEdit.uri);

				// Convert server edit format to TextEdit[]
				const textEdits: TextEdit[] = fileEdit.edits.map(edit => ({
					range: new Range(
						edit.range.startLineNumber,
						edit.range.startColumn,
						edit.range.endLineNumber,
						edit.range.endColumn
					),
					text: edit.text
				}));

				// Send as IChatTextEdit progress update to trigger Agent Mode file editing
				const chatTextEdit: IChatTextEdit = {
					kind: 'textEdit',
					uri: uri,
					edits: textEdits,
					done: true // Mark as done since we're sending all edits at once
				};

				progress([chatTextEdit]);

				this.logService.info(`[BrowserDefaultChatAgent] Sent text edits for ${uri.toString()}:`, textEdits.length);

			} catch (error) {
				this.logService.error('[BrowserDefaultChatAgent] Error processing file edit:', error);
			}
		}
	}

	/**
	 * Processes notebook edits and sends them as IChatNotebookEdit progress updates
	 */
	private async processNotebookEdits(
		notebookEdits: Array<{ uri: string; cellOperations: ICellEditOperation[]; }>,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken
	): Promise<void> {
		this.logService.info('[BrowserDefaultChatAgent] Processing notebook edits:', notebookEdits.length);

		for (const notebookEdit of notebookEdits) {
			if (token.isCancellationRequested) {
				break;
			}

			try {
				const uri = URI.parse(notebookEdit.uri);

				// Send as IChatNotebookEdit progress update to trigger Agent Mode notebook editing
				const chatNotebookEdit: IChatNotebookEdit = {
					kind: 'notebookEdit',
					uri: uri,
					edits: notebookEdit.cellOperations,
					done: true // Mark as done since we're sending all edits at once
				};

				progress([chatNotebookEdit]);

				this.logService.info(`[BrowserDefaultChatAgent] Sent notebook edits for ${uri.toString()}:`, notebookEdit.cellOperations.length);

			} catch (error) {
				this.logService.error('[BrowserDefaultChatAgent] Error processing notebook edit:', error);
			}
		}
	}
	private getHelpResponse(): string {
		const serverEnabled = this.serverConfig.enabled;

		return `# 🤖 VS Code AI Assistant ${serverEnabled ? '(Powered by Local Claude Server)' : '(Basic Mode)'}

${serverEnabled ?
				`I'm your AI assistant powered by Claude via your local server! I can help you with a wide range of coding and VS Code-related tasks.

## 🚀 What I can do:
- **Code Generation**: Write, debug, and explain code in multiple languages
- **Problem Solving**: Help troubleshoot coding issues and errors
- **Documentation**: Generate comments, README files, and documentation
- **Code Review**: Analyze and suggest improvements for your code
- **VS Code Help**: Assist with extensions, settings, and features
- **Context-Aware Assistance**: I can see your current file, selection, and attached files
- **General Programming**: Answer questions about algorithms, best practices, and more

## 🧠 Context Features:
- **Active File**: I can see the file you're currently editing
- **Text Selection**: I understand what code you have selected
- **Open Files**: I'm aware of other files you have open
- **File Attachments**: You can attach files to your chat for analysis

## 💡 Try asking me:
- "Write a Python function to sort a list"
- "Explain this JavaScript code" (with code selected)
- "How do I configure VS Code for React development?"
- "Debug this error message"
- "Generate unit tests for this function"
- "Review my code" (with files attached)

## 🔧 Server Status:
- **Server URL**: ${this.serverConfig.baseUrl}/ai/claude/agent
- **Status**: ${serverEnabled ? '✅ Enabled with Context Support' : '❌ Disabled'}` :

				`I'm your basic VS Code assistant. Your local Claude server appears to be disabled.

## 📝 What I can do (Basic Mode):
- **Extensions**: Help you find and understand VS Code extensions
- **Browser Features**: Explain what works in VS Code web vs desktop
- **Code Assistance**: Provide basic coding tips and VS Code shortcuts
- **Settings**: Guide you through VS Code configuration
- **General Questions**: Answer questions about using VS Code

## ⚙️ Enable Local Claude Server:
1. Make sure your local server is running on ${this.serverConfig.baseUrl}
2. Test with: \`curl -X POST ${this.serverConfig.baseUrl}/ai/claude/agent -H "Content-Type: application/json" -d "{\\"message\\": \\"Hello\\"}" \`
3. Check VS Code settings for server configuration

## 💡 Try asking me:
- "How do I install extensions in VS Code web?"
- "What are the differences between VS Code web and desktop?"
- "How do I change my theme?"
- "What keyboard shortcuts should I know?"`}

Feel free to ask me anything! 😊`;
	}

	private getExtensionResponse(): string {
		return `# 🔌 Extensions in VS Code Web

Here's what you need to know about extensions in the browser:

## ✅ Web Extensions
- Many extensions work in VS Code web, but they must be specifically designed for web environments
- Look for extensions marked as "Web Extension" in the marketplace
- Language support, themes, and keymaps generally work well

## 📦 Installing Extensions
1. Click the Extensions icon in the Activity Bar (or press \`Ctrl+Shift+X\`)
2. Search for the extension you want
3. Look for the "Install" button (some may show "Install in Web")
4. Web-compatible extensions will install and work immediately

## ⚠️ Limitations
- Extensions that require Node.js or system access won't work
- Some language servers and debuggers may have limited functionality
- File system access is restricted compared to desktop

## 🔍 Popular Web Extensions
- **Themes**: Most theme extensions work perfectly
- **Language Support**: TypeScript, JavaScript, Python basics
- **Formatters**: Prettier, ESLint (with some limitations)
- **Git**: Basic Git support is built-in`;
	}

	private getBrowserResponse(): string {
		return `# 🌐 VS Code in the Browser

You're using VS Code in a web browser! Here are the key things to know:

## ✨ Browser Advantages
- **No Installation**: Access VS Code instantly from any device
- **Anywhere Access**: Work from any computer with a web browser
- **Always Updated**: Always running the latest version
- **Lightweight**: No local installation required

## 🔧 What Works
- **File Editing**: Full editing capabilities with syntax highlighting
- **Extensions**: Many extensions work (look for "Web Extension" badge)
- **Git**: Basic Git operations through the web interface
- **Themes**: All themes and color schemes
- **Settings Sync**: Sync your settings across devices

## ⚠️ Browser Limitations
- **File System**: Limited local file access (use "Open Folder" for better experience)
- **Terminal**: Limited terminal capabilities compared to desktop
- **Extensions**: Some extensions require Node.js and won't work
- **Performance**: May be slower for very large projects

## 💡 Pro Tips
- Use GitHub Codespaces or Gitpod for full development environments
- Enable Settings Sync to keep your preferences across devices
- Use the Command Palette (\`Ctrl+Shift+P\`) for quick access to features`;
	}

	private getCodeResponse(): string {
		return `# 👨‍💻 Coding in VS Code Web

VS Code web provides excellent coding capabilities! Here's how to make the most of it:

## 🔥 Essential Shortcuts
- \`Ctrl+Shift+P\`: Command Palette (your best friend!)
- \`Ctrl+P\`: Quick file open
- \`Ctrl+\`\`: Toggle terminal
- \`Ctrl+Shift+E\`: Explorer panel
- \`Ctrl+/\`: Toggle line comment
- \`Alt+Shift+F\`: Format document

## ✨ Coding Features
- **IntelliSense**: Smart code completion
- **Syntax Highlighting**: For 100+ languages
- **Code Folding**: Collapse/expand code blocks
- **Multi-cursor**: \`Alt+Click\` for multiple cursors
- **Find & Replace**: \`Ctrl+F\` and \`Ctrl+H\`

## 🎨 Customization
- **Themes**: Change appearance in Settings → Color Theme
- **Font Size**: \`Ctrl+\` and \`Ctrl-\` to zoom
- **Layout**: Drag panels to reorganize your workspace

## 📁 Working with Files
- **Open Folder**: Better experience than individual files
- **File Explorer**: Navigate your project structure
- **Quick Open**: \`Ctrl+P\` to quickly find files

## 🐛 Debugging
- Basic debugging available for supported languages
- Set breakpoints by clicking line numbers
- Use Debug panel for step-through debugging`;
	}

	private getSettingsResponse(): string {
		return `# ⚙️ VS Code Settings & Configuration

Customize VS Code to work exactly how you want:

## 🎯 Quick Settings Access
- **Settings UI**: \`Ctrl+,\` for the graphical interface
- **Settings JSON**: \`Ctrl+Shift+P\` → "Open Settings (JSON)"
- **Keyboard Shortcuts**: \`Ctrl+K Ctrl+S\`

## 🎨 Popular Customizations
\`\`\`json
{
  "editor.fontSize": 14,
  "editor.tabSize": 2,
  "editor.wordWrap": "on",
  "editor.minimap.enabled": false,
  "workbench.colorTheme": "Dark+ (default dark)",
  "editor.fontFamily": "Fira Code, Consolas, monospace"
}
\`\`\`

## 🌟 Essential Settings
- **Font Size**: Adjust for better readability
- **Theme**: Choose from hundreds of available themes
- **Tab Size**: Set your preferred indentation
- **Word Wrap**: Enable for long lines
- **Auto Save**: \`"files.autoSave": "afterDelay"\`

## 🔄 Settings Sync
- Enable Settings Sync to keep preferences across devices
- Sign in with Microsoft or GitHub account
- Syncs settings, keybindings, extensions, and snippets

## 🔍 Finding Settings
- Use the search box in Settings
- Settings are organized by category
- Look for gear icons throughout the UI for contextual settings`;
	}

	private getDefaultResponse(userMessage: string): string {
		return `# 💬 Thanks for your question!

You asked: "${userMessage}"

I'm a basic chat assistant for VS Code web. While I can help with general VS Code questions, I have limited capabilities compared to advanced AI assistants.

## 🤔 I can help with:
- VS Code features and shortcuts
- Extension recommendations
- Browser-specific limitations
- Basic coding tips
- Settings and configuration

## 💡 For more advanced help:
- Check the [VS Code Documentation](https://code.visualstudio.com/docs)
- Visit the [VS Code Community](https://github.com/microsoft/vscode/discussions)
- Consider installing a more advanced AI extension if available

Feel free to ask me about any VS Code features or how to use the editor more effectively! 😊

**Try asking**: "How do I change my theme?" or "What extensions work in the browser?"`;
	}
}

/**
 * Contribution that registers the browser default chat agent when running in web environment
 */
export class BrowserDefaultChatAgentContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.browserDefaultChatAgent';

	constructor(
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		// Only register in web environments
		if (isWeb) {
			this.registerBrowserDefaultAgent();
		}
	} private registerBrowserDefaultAgent(): void {
		try {
			this.logService.info('[BrowserDefaultChatAgentContribution] Registering browser default chat agents');

			// Create shared agent implementation
			const agentImpl = this.instantiationService.createInstance(BrowserDefaultChatAgent);

			// Register Ask mode agent
			this.registerAgentForMode('vscode.browserDefaultChat', 'Claude Assistant', ChatMode.Ask, agentImpl);

			// Register Edit mode agent
			this.registerAgentForMode('vscode.browserDefaultEdit', 'Claude Assistant', ChatMode.Edit, agentImpl);

			// Register Agent mode agent (with context key condition)
			this.registerAgentForMode('vscode.browserDefaultAgent', 'Claude Assistant', ChatMode.Agent, agentImpl);

			this.logService.info('[BrowserDefaultChatAgentContribution] Successfully registered browser default chat agents');

		} catch (error) {
			this.logService.error('[BrowserDefaultChatAgentContribution] Failed to register browser default chat agents:', error);
		}
	}
	private registerAgentForMode(id: string, name: string, mode: ChatMode, agentImpl: BrowserDefaultChatAgent): void {
		// Create agent data for specific mode
		const agentData: IChatAgentData = {
			id,
			name,
			fullName: mode === ChatMode.Agent
				? `Claude AI Assistant for VS Code (Agent)`
				: `Claude AI Assistant for VS Code (${mode === ChatMode.Ask ? 'Chat' : 'Edit'})`,
			description: mode === ChatMode.Ask
				? 'AI-powered chat assistant using Claude Sonnet 4'
				: mode === ChatMode.Edit
					? 'AI-powered editing assistant using Claude Sonnet 4'
					: 'AI-powered agent assistant with tools using Claude Sonnet 4',
			extensionId: nullExtensionDescription.identifier,
			extensionDisplayName: 'VS Code',
			extensionPublisherId: 'vscode',
			publisherDisplayName: 'Microsoft',
			isDefault: true,
			isCore: true,
			metadata: {
				themeIcon: mode === ChatMode.Agent ? Codicon.tools : Codicon.commentDiscussion,
				helpTextPrefix: mode === ChatMode.Ask
					? 'Ask me anything about coding, VS Code, or get help with your development tasks!'
					: mode === ChatMode.Edit
						? 'I can help you edit your code. Describe what changes you want to make.'
						: 'I can help you with development tasks using available tools and workspace context.',
				sampleRequest: mode === ChatMode.Ask
					? 'Write a Python function to calculate fibonacci numbers'
					: mode === ChatMode.Edit
						? 'Add error handling to this function'
						: 'Analyze my project structure and suggest improvements'
			},
			locations: [ChatAgentLocation.Editor, ChatAgentLocation.Panel, ChatAgentLocation.Terminal],
			modes: [mode], // Single mode per agent to avoid context key conflicts
			slashCommands: [],
			disambiguation: [],
			when: mode === ChatMode.Agent ? ToolsAgentContextKey?.serialize() : undefined
		};

		// Register the agent data
		const agentRegistration = this.chatAgentService.registerAgent(id, agentData);
		this._register(agentRegistration);

		// Register the shared implementation for this agent ID
		const implRegistration = this.chatAgentService.registerAgentImplementation(id, agentImpl);
		this._register(implRegistration);

		this.logService.info(`[BrowserDefaultChatAgentContribution] Registered ${mode} mode agent: ${id}`);
	}
}
