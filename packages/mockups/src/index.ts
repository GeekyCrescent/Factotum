/**
 * Mockups, as the composition root sees it (spec 2026-11-12-maquetas).
 *
 * `packages/cli` imports `createMockups` and `createMockupsLink` from here and hands them to
 * `mockupsModule`. Nothing in `modules/` imports this package: it declares the same shapes by hand and
 * the two meet at one assignment in `main.ts`, as `tasks` does (criterion 43).
 */

export type {
  AgentCall,
  AgentTool,
  AgentToolImpl,
  AgentToolResult,
  Change,
  CreateMockups,
  CreateMockupsResult,
  Created,
  Decided,
  Decision,
  DocFile,
  IncomingFile,
  InputRef,
  Mockup,
  MockupError,
  Mockups,
  MockupsDeps,
  MockupsLink,
  MockupsSetup,
  ProjectEntry,
  Result,
  Run,
  RunKind,
  RunTicket,
  StageId,
  StageOption,
  Step,
  StepStatus,
} from './types.ts'
export { createMockups } from './mockups.ts'
export { createMockupsLink } from './link.ts'
