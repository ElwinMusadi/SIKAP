// Worker entrypoints may export handlers, not string constants/test helpers.
// Keep the reusable implementation in index.ts and expose only the default handler.
export { default } from './index';
