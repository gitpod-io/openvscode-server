import svelte from 'rollup-plugin-svelte';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import livereload from 'rollup-plugin-livereload';
import { terser } from 'rollup-plugin-terser';
import sveltePreprocess from 'svelte-preprocess';
import typescript from '@rollup/plugin-typescript';
import alias from '@rollup/plugin-alias';
import css from 'rollup-plugin-css-only';
import path from 'path';
import copy from 'rollup-plugin-copy';
import json from '@rollup/plugin-json';

const production = !process.env.ROLLUP_WATCH;

function serve() {
	let server;

	function toExit() {
		if (server) { server.kill(0); }
	}

	return {
		writeBundle() {
			if (server) { return; }
			server = require('child_process').spawn('npm', ['run', 'start', '--', '--dev'], {
				stdio: ['ignore', 'inherit', 'inherit'],
				shell: true
			});

			process.on('SIGTERM', toExit);
			process.on('exit', toExit);
		}
	};
}

export default {
	input: path.join(__dirname, '../gitpod-shared/portsview/src/main.ts'),
	output: [
		{
			sourcemap: !production,
			format: 'es',
			file: path.join(__dirname, './public/portsview.js'),
		},
	],
	plugins: [
		alias({
			entries: [
				{ find: 'package.nls.json', replacement: path.join(__dirname, 'package.nls.json') },
			]
		}),
		svelte({
			preprocess: sveltePreprocess({
				typescript: {
					tsconfigFile: '../gitpod-shared/portsview/tsconfig.json'
				},
				sourceMap: !production
			}),
			compilerOptions: {
				// enable run-time checks when not in production
				dev: !production
			}
		}),
		copy({
			targets: [
				{ src: 'node_modules/@vscode/codicons/dist/codicon.css', dest: 'public' },
				{ src: 'node_modules/@vscode/codicons/dist/codicon.ttf', dest: 'public' }
			],
		}),
		json({ compact: true }),
		// we'll extract any component CSS out into
		// a separate file - better for performance
		css({ output: 'portsview.css' }),

		// If you have external dependencies installed from
		// npm, you'll most likely need these plugins. In
		// some cases you'll need additional configuration -
		// consult the documentation for details:
		// https://github.com/rollup/plugins/tree/master/packages/commonjs
		resolve({
			browser: true,
			dedupe: ['svelte']
		}),
		commonjs(),
		typescript({
			sourceMap: !production,
			inlineSources: !production,
			tsconfig: '../gitpod-shared/portsview/tsconfig.json'
		}),

		// In dev mode, call `npm run start` once
		// the bundle has been generated
		// !production && serve(),

		// Watch the `public` directory and refresh the
		// browser on changes when not in production
		!production && livereload('public'),

		// If we're building for production (npm run build
		// instead of npm run dev), minify
		production && terser()
	],
	watch: {
		clearScreen: false
	}
};
