import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dts from 'vite-plugin-dts'
import tsConfigPaths from 'vite-tsconfig-paths'
import terser from '@rollup/plugin-terser'
import browserslist from 'browserslist'
import { browserslistToTargets, transform } from 'lightningcss'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { glob } from 'glob'
import * as packageJson from './package.json'

const __dirname = dirname(fileURLToPath(import.meta.url))

const filterFiles = glob.sync('src/filters/*.ts').reduce((acc, file) => {
    const name = file.replace('src/', '').replace('.ts', '')
    acc[name] = resolve(__dirname, file)
    return acc
}, {})

const formatterFiles = glob.sync('src/formatters/*.ts').reduce((acc, file) => {
    const name = file.replace('src/', '').replace('.ts', '')
    acc[name] = resolve(__dirname, file)
    return acc
}, {})

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        tsConfigPaths(),
        dts({
            insertTypesEntry: true,
            exclude: ['node_modules/**/*'],
        }),
        viteStaticCopy({
            targets: [
                {
                    src: 'src/formatters/styles/*.css',
                    dest: 'formatters/styles',
                    transform: (content, file) => {
                        return new Promise((resolve) => {
                            resolve(
                                transform({
                                    filename: file,
                                    code: Buffer.from(content),
                                    minify: true,
                                    targets: browserslistToTargets(browserslist('>= 0.25%')),
                                }).code.toString(),
                            )
                        })
                    },
                },
            ],
        }),
    ],
    build: {
        lib: {
            entry: {
                jsondiffpatch: resolve(__dirname, 'src/index.ts'),
                'with-text-diffs': resolve(__dirname, 'src/with-text-diffs.ts'),
                ...filterFiles,
                ...formatterFiles,
            },
            name: 'jsondiffpatch',
            formats: ['es'],
            // fileName: (format) => `jsondiffpatch.${format}.js`,
        },
        outDir: resolve(__dirname, 'lib'),
        emptyOutDir: true,
        rollupOptions: {
            external: Object.keys(packageJson.devDependencies),
            output: {
                plugins: [terser()],
            },
        },
    },
})
