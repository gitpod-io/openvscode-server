/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILanguageIdCodec, ITreeSitterTokenizationSupport, TreeSitterTokenizationRegistry } from '../languages.js';
import { LineTokens } from '../tokens/lineTokens.js';
import { StandardTokenType } from '../encodedTokenAttributes.js';
import { TextModel } from './textModel.js';
import { ITreeSitterParserService } from '../services/treeSitterParserService.js';
import { IModelContentChangedEvent } from '../textModelEvents.js';
import { AbstractTokens } from './tokens.js';
import { IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';

export class TreeSitterTokens extends AbstractTokens {
	private _tokenizationSupport: ITreeSitterTokenizationSupport | null = null;
	private _lastLanguageId: string | undefined;
	private readonly _tokensChangedListener: MutableDisposable<IDisposable> = this._register(new MutableDisposable());

	constructor(languageIdCodec: ILanguageIdCodec,
		textModel: TextModel,
		languageId: () => string,
		@ITreeSitterParserService private readonly _treeSitterService: ITreeSitterParserService) {
		super(languageIdCodec, textModel, languageId);

		this._initialize();
	}

	private _initialize() {
		const newLanguage = this.getLanguageId();
		if (!this._tokenizationSupport || this._lastLanguageId !== newLanguage) {
			this._lastLanguageId = newLanguage;
			this._tokenizationSupport = TreeSitterTokenizationRegistry.get(newLanguage);
			this._tokensChangedListener.value = this._tokenizationSupport?.onDidChangeTokens((e) => {
				if (e.textModel === this._textModel) {
					this._onDidChangeTokens.fire(e.changes);
				}
			});
		}
	}

	public getLineTokens(lineNumber: number): LineTokens {
		const content = this._textModel.getLineContent(lineNumber);
		if (this._tokenizationSupport) {
			const rawTokens = this._tokenizationSupport.tokenizeEncoded(lineNumber, this._textModel);
			if (rawTokens) {
				return new LineTokens(rawTokens, content, this._languageIdCodec);
			}
		}
		return LineTokens.createEmpty(content, this._languageIdCodec);
	}

	public resetTokenization(fireTokenChangeEvent: boolean = true): void {
		if (fireTokenChangeEvent) {
			this._onDidChangeTokens.fire({
				semanticTokensApplied: false,
				ranges: [
					{
						fromLineNumber: 1,
						toLineNumber: this._textModel.getLineCount(),
					},
				],
			});
		}
		this._initialize();
	}

	public override handleDidChangeAttached(): void {
		// TODO @alexr00 implement for background tokenization
	}

	public override handleDidChangeContent(e: IModelContentChangedEvent): void {
		if (e.isFlush) {
			// Don't fire the event, as the view might not have got the text change event yet
			this.resetTokenization(false);
		}
	}

	public override forceTokenization(lineNumber: number): void {
		// TODO @alexr00 implement
	}

	public override hasAccurateTokensForLine(lineNumber: number): boolean {
		// TODO @alexr00 update for background tokenization
		return true;
	}

	public override isCheapToTokenize(lineNumber: number): boolean {
		// TODO @alexr00 update for background tokenization
		return true;
	}

	public override getTokenTypeIfInsertingCharacter(lineNumber: number, column: number, character: string): StandardTokenType {
		// TODO @alexr00 implement once we have custom parsing and don't just feed in the whole text model value
		return StandardTokenType.Other;
	}
	public override tokenizeLinesAt(lineNumber: number, lines: string[]): LineTokens[] | null {
		// TODO @alexr00 understand what this is for and implement
		return null;
	}
	public override get hasTokens(): boolean {
		// TODO @alexr00 once we have a token store, implement properly
		const hasTree = this._treeSitterService.getParseResult(this._textModel) !== undefined;
		return hasTree;
	}
}
