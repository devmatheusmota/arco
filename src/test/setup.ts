import '@testing-library/jest-dom/vitest'

import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The hook listener writes its settings, `.mcp.json` included, at this path, and
// the panes of the running app read them from the default one in the temp dir. A
// suite that started the listener on the default path would hand every pane
// opened in the next 30s a port that is gone by then. Assigned outright so a
// value inherited from the shell cannot point the tests back at the real file;
// suites that need their own path still set it after this runs.
process.env.ARCO_HOOKS_SETTINGS_FILE = join(tmpdir(), 'arco-test-agent-hooks.json')
