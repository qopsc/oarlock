import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),resolve:{alias:{'@':fileURLToPath(new URL('../../src',import.meta.url))}},build:{outDir:'/tmp/oarlock-editor-regex-probe',emptyOutDir:true}});
