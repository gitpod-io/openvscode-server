"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.watchApiProposalNamesTask = exports.compileApiProposalNamesTask = exports.watchTask = exports.compileTask = exports.transpileTask = void 0;
const es = require("event-stream");
const fs = require("fs");
const gulp = require("gulp");
const path = require("path");
const monacodts = require("./monaco-api");
const nls = require("./nls");
const reporter_1 = require("./reporter");
const util = require("./util");
const fancyLog = require("fancy-log");
const ansiColors = require("ansi-colors");
const os = require("os");
const ts = require("typescript");
const File = require("vinyl");
const task = require("./task");
const index_1 = require("./mangle/index");
const watch = require('./watch');
const packageJson = require('../../package.json');
const productJson = require('../../product.json');
const replace = require('gulp-replace');
// --- gulp-tsb: compile and transpile --------------------------------
const reporter = (0, reporter_1.createReporter)();
function getTypeScriptCompilerOptions(src) {
    const rootDir = path.join(__dirname, `../../${src}`);
    const options = {};
    options.verbose = false;
    options.sourceMap = true;
    if (process.env['VSCODE_NO_SOURCEMAP']) { // To be used by developers in a hurry
        options.sourceMap = false;
    }
    options.rootDir = rootDir;
    options.baseUrl = rootDir;
    options.sourceRoot = util.toFileUri(rootDir);
    options.newLine = /\r\n/.test(fs.readFileSync(__filename, 'utf8')) ? 0 : 1;
    return options;
}
function createCompile(src, build, emitError, transpileOnly) {
    const tsb = require('./tsb');
    const sourcemaps = require('gulp-sourcemaps');
    const projectPath = path.join(__dirname, '../../', src, 'tsconfig.json');
    const overrideOptions = { ...getTypeScriptCompilerOptions(src), inlineSources: Boolean(build) };
    if (!build) {
        overrideOptions.inlineSourceMap = true;
    }
    const compilation = tsb.create(projectPath, overrideOptions, {
        verbose: false,
        transpileOnly: Boolean(transpileOnly),
        transpileWithSwc: typeof transpileOnly !== 'boolean' && transpileOnly.swc
    }, err => reporter(err));
    function pipeline(token) {
        const bom = require('gulp-bom');
        const tsFilter = util.filter(data => /\.ts$/.test(data.path));
        const isUtf8Test = (f) => /(\/|\\)test(\/|\\).*utf8/.test(f.path);
        const isRuntimeJs = (f) => f.path.endsWith('.js') && !f.path.includes('fixtures');
        const noDeclarationsFilter = util.filter(data => !(/\.d\.ts$/.test(data.path)));
        const productJsFilter = util.filter(data => !build && data.path.endsWith('vs/platform/product/common/product.ts'));
        const productConfiguration = JSON.stringify({
            ...productJson,
            version: `${packageJson.version}-dev`,
            nameShort: `${productJson.nameShort} Dev`,
            nameLong: `${productJson.nameLong} Dev`,
            dataFolderName: `${productJson.dataFolderName}-dev`
        });
        const input = es.through();
        const output = input
            .pipe(productJsFilter)
            .pipe(replace(/{\s*\/\*BUILD->INSERT_PRODUCT_CONFIGURATION\*\/\s*}/, productConfiguration, { skipBinary: true }))
            .pipe(productJsFilter.restore)
            .pipe(util.$if(isUtf8Test, bom())) // this is required to preserve BOM in test files that loose it otherwise
            .pipe(util.$if(!build && isRuntimeJs, util.appendOwnPathSourceURL()))
            .pipe(tsFilter)
            .pipe(util.loadSourcemaps())
            .pipe(compilation(token))
            .pipe(noDeclarationsFilter)
            .pipe(util.$if(build, nls.nls()))
            .pipe(noDeclarationsFilter.restore)
            .pipe(util.$if(!transpileOnly, sourcemaps.write('.', {
            addComment: false,
            includeContent: !!build,
            sourceRoot: overrideOptions.sourceRoot
        })))
            .pipe(tsFilter.restore)
            .pipe(reporter.end(!!emitError));
        return es.duplex(input, output);
    }
    pipeline.tsProjectSrc = () => {
        return compilation.src({ base: src });
    };
    pipeline.projectPath = projectPath;
    return pipeline;
}
function transpileTask(src, out, swc) {
    return function () {
        const transpile = createCompile(src, false, true, { swc });
        const srcPipe = gulp.src(`${src}/**`, { base: `${src}` });
        return srcPipe
            .pipe(transpile())
            .pipe(gulp.dest(out));
    };
}
exports.transpileTask = transpileTask;
function compileTask(src, out, build, options = {}) {
    return function () {
        if (os.totalmem() < 4000000000) {
            throw new Error('compilation requires 4GB of RAM');
        }
        const compile = createCompile(src, build, true, false);
        const srcPipe = gulp.src(`${src}/**`, { base: `${src}` });
        const generator = new MonacoGenerator(false);
        if (src === 'src') {
            generator.execute();
        }
        // mangle: TypeScript to TypeScript
        let mangleStream = es.through();
        if (build && !options.disableMangle) {
            let ts2tsMangler = new index_1.Mangler(compile.projectPath, (...data) => fancyLog(ansiColors.blue('[mangler]'), ...data), { mangleExports: true, manglePrivateFields: true });
            const newContentsByFileName = ts2tsMangler.computeNewFileContents(new Set(['saveState']));
            mangleStream = es.through(async function write(data) {
                const tsNormalPath = ts.normalizePath(data.path);
                const newContents = (await newContentsByFileName).get(tsNormalPath);
                if (newContents !== undefined) {
                    data.contents = Buffer.from(newContents.out);
                    data.sourceMap = newContents.sourceMap && JSON.parse(newContents.sourceMap);
                }
                this.push(data);
            }, async function end() {
                // free resources
                (await newContentsByFileName).clear();
                this.push(null);
                ts2tsMangler = undefined;
            });
        }
        return srcPipe
            .pipe(mangleStream)
            .pipe(generator.stream)
            .pipe(compile())
            .pipe(gulp.dest(out));
    };
}
exports.compileTask = compileTask;
function watchTask(out, build) {
    return function () {
        const compile = createCompile('src', build, false, false);
        const src = gulp.src('src/**', { base: 'src' });
        const watchSrc = watch('src/**', { base: 'src', readDelay: 200 });
        const generator = new MonacoGenerator(true);
        generator.execute();
        return watchSrc
            .pipe(generator.stream)
            .pipe(util.incremental(compile, src, true))
            .pipe(gulp.dest(out));
    };
}
exports.watchTask = watchTask;
const REPO_SRC_FOLDER = path.join(__dirname, '../../src');
class MonacoGenerator {
    _isWatch;
    stream;
    _watchedFiles;
    _fsProvider;
    _declarationResolver;
    constructor(isWatch) {
        this._isWatch = isWatch;
        this.stream = es.through();
        this._watchedFiles = {};
        const onWillReadFile = (moduleId, filePath) => {
            if (!this._isWatch) {
                return;
            }
            if (this._watchedFiles[filePath]) {
                return;
            }
            this._watchedFiles[filePath] = true;
            fs.watchFile(filePath, () => {
                this._declarationResolver.invalidateCache(moduleId);
                this._executeSoon();
            });
        };
        this._fsProvider = new class extends monacodts.FSProvider {
            readFileSync(moduleId, filePath) {
                onWillReadFile(moduleId, filePath);
                return super.readFileSync(moduleId, filePath);
            }
        };
        this._declarationResolver = new monacodts.DeclarationResolver(this._fsProvider);
        if (this._isWatch) {
            fs.watchFile(monacodts.RECIPE_PATH, () => {
                this._executeSoon();
            });
        }
    }
    _executeSoonTimer = null;
    _executeSoon() {
        if (this._executeSoonTimer !== null) {
            clearTimeout(this._executeSoonTimer);
            this._executeSoonTimer = null;
        }
        this._executeSoonTimer = setTimeout(() => {
            this._executeSoonTimer = null;
            this.execute();
        }, 20);
    }
    _run() {
        const r = monacodts.run3(this._declarationResolver);
        if (!r && !this._isWatch) {
            // The build must always be able to generate the monaco.d.ts
            throw new Error(`monaco.d.ts generation error - Cannot continue`);
        }
        return r;
    }
    _log(message, ...rest) {
        fancyLog(ansiColors.cyan('[monaco.d.ts]'), message, ...rest);
    }
    execute() {
        const startTime = Date.now();
        const result = this._run();
        if (!result) {
            // nothing really changed
            return;
        }
        if (result.isTheSame) {
            return;
        }
        fs.writeFileSync(result.filePath, result.content);
        fs.writeFileSync(path.join(REPO_SRC_FOLDER, 'vs/editor/common/standalone/standaloneEnums.ts'), result.enums);
        this._log(`monaco.d.ts is changed - total time took ${Date.now() - startTime} ms`);
        if (!this._isWatch) {
            this.stream.emit('error', 'monaco.d.ts is no longer up to date. Please run gulp watch and commit the new file.');
        }
    }
}
function generateApiProposalNames() {
    let eol;
    try {
        const src = fs.readFileSync('src/vs/workbench/services/extensions/common/extensionsApiProposals.ts', 'utf-8');
        const match = /\r?\n/m.exec(src);
        eol = match ? match[0] : os.EOL;
    }
    catch {
        eol = os.EOL;
    }
    const pattern = /vscode\.proposed\.([a-zA-Z]+)\.d\.ts$/;
    const proposalNames = new Set();
    const input = es.through();
    const output = input
        .pipe(util.filter((f) => pattern.test(f.path)))
        .pipe(es.through((f) => {
        const name = path.basename(f.path);
        const match = pattern.exec(name);
        if (match) {
            proposalNames.add(match[1]);
        }
    }, function () {
        const names = [...proposalNames.values()].sort();
        const contents = [
            '/*---------------------------------------------------------------------------------------------',
            ' *  Copyright (c) Microsoft Corporation. All rights reserved.',
            ' *  Licensed under the MIT License. See License.txt in the project root for license information.',
            ' *--------------------------------------------------------------------------------------------*/',
            '',
            '// THIS IS A GENERATED FILE. DO NOT EDIT DIRECTLY.',
            '',
            'export const allApiProposals = Object.freeze({',
            `${names.map(name => `\t${name}: 'https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.${name}.d.ts'`).join(`,${eol}`)}`,
            '});',
            'export type ApiProposalName = keyof typeof allApiProposals;',
            '',
        ].join(eol);
        this.emit('data', new File({
            path: 'vs/workbench/services/extensions/common/extensionsApiProposals.ts',
            contents: Buffer.from(contents)
        }));
        this.emit('end');
    }));
    return es.duplex(input, output);
}
const apiProposalNamesReporter = (0, reporter_1.createReporter)('api-proposal-names');
exports.compileApiProposalNamesTask = task.define('compile-api-proposal-names', () => {
    return gulp.src('src/vscode-dts/**')
        .pipe(generateApiProposalNames())
        .pipe(gulp.dest('src'))
        .pipe(apiProposalNamesReporter.end(true));
});
exports.watchApiProposalNamesTask = task.define('watch-api-proposal-names', () => {
    const task = () => gulp.src('src/vscode-dts/**')
        .pipe(generateApiProposalNames())
        .pipe(apiProposalNamesReporter.end(true));
    return watch('src/vscode-dts/**', { readDelay: 200 })
        .pipe(util.debounce(task))
        .pipe(gulp.dest('src'));
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29tcGlsYXRpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjb21waWxhdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7OztnR0FHZ0c7OztBQUVoRyxtQ0FBbUM7QUFDbkMseUJBQXlCO0FBQ3pCLDZCQUE2QjtBQUM3Qiw2QkFBNkI7QUFDN0IsMENBQTBDO0FBQzFDLDZCQUE2QjtBQUM3Qix5Q0FBNEM7QUFDNUMsK0JBQStCO0FBQy9CLHNDQUFzQztBQUN0QywwQ0FBMEM7QUFDMUMseUJBQXlCO0FBQ3pCLGlDQUFrQztBQUNsQyw4QkFBOEI7QUFDOUIsK0JBQStCO0FBQy9CLDBDQUF5QztBQUV6QyxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDakMsTUFBTSxXQUFXLEdBQUcsT0FBTyxDQUFDLG9CQUFvQixDQUFDLENBQUM7QUFDbEQsTUFBTSxXQUFXLEdBQUcsT0FBTyxDQUFDLG9CQUFvQixDQUFDLENBQUM7QUFDbEQsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLGNBQWMsQ0FBQyxDQUFDO0FBR3hDLHVFQUF1RTtBQUV2RSxNQUFNLFFBQVEsR0FBRyxJQUFBLHlCQUFjLEdBQUUsQ0FBQztBQUVsQyxTQUFTLDRCQUE0QixDQUFDLEdBQVc7SUFDaEQsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsU0FBUyxHQUFHLEVBQUUsQ0FBQyxDQUFDO0lBQ3JELE1BQU0sT0FBTyxHQUF1QixFQUFFLENBQUM7SUFDdkMsT0FBTyxDQUFDLE9BQU8sR0FBRyxLQUFLLENBQUM7SUFDeEIsT0FBTyxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUM7SUFDekIsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLHFCQUFxQixDQUFDLEVBQUUsRUFBRSxzQ0FBc0M7UUFDL0UsT0FBTyxDQUFDLFNBQVMsR0FBRyxLQUFLLENBQUM7S0FDMUI7SUFDRCxPQUFPLENBQUMsT0FBTyxHQUFHLE9BQU8s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