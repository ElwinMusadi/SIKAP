// Deployment boundary: export only the default fetch handler. Test helpers stay
// in uat-entry.ts and are never exposed as named Worker entrypoints.
import { createUatHandler } from './uat-entry';
export default createUatHandler();
