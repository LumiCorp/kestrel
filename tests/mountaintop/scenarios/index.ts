import { nextJsTemplateAuthSettingsAdminScenario } from "./nextjs-template-auth-settings-admin.js";
import { nextJsTemplateDualShellScenario } from "./nextjs-template-dual-shell.js";
import { nextJsTemplateFullStackTaskBoardScenario } from "./nextjs-template-full-stack-task-board.js";
import { nextJsTemplateLongRunningStatefulWorkflowScenario } from "./nextjs-template-long-running-stateful-workflow.js";
import { nextJsTemplateMultiPackageSharedPackageScenario } from "./nextjs-template-multi-package-shared-package.js";
import { nextJsTemplateNewsletterResearchRealUserCliScenario } from "./nextjs-template-newsletter-research-real-user-cli.js";
import { nextJsTemplateNewsletterRealUserCliScenario } from "./nextjs-template-newsletter-real-user-cli.js";
import { nextJsTemplateScaffoldRealUserCliScenario } from "./nextjs-template-scaffold-real-user-cli.js";
import { nextJsTemplateScaffoldSmokeScenario } from "./nextjs-template-scaffold-smoke.js";
import { nextJsTemplateStagedStatefulWorkflowScenario } from "./nextjs-template-staged-stateful-workflow.js";
import { nextJsTemplateTodoAuthRealUserCliScenario } from "./nextjs-template-todo-auth-real-user-cli.js";
import type { MountaintopScenario } from "../types.js";

export const MOUNTAINTOP_SCENARIOS: MountaintopScenario[] = [
  nextJsTemplateScaffoldSmokeScenario,
  nextJsTemplateScaffoldRealUserCliScenario,
  nextJsTemplateNewsletterResearchRealUserCliScenario,
  nextJsTemplateNewsletterRealUserCliScenario,
  nextJsTemplateDualShellScenario,
  nextJsTemplateMultiPackageSharedPackageScenario,
  nextJsTemplateFullStackTaskBoardScenario,
  nextJsTemplateTodoAuthRealUserCliScenario,
  nextJsTemplateAuthSettingsAdminScenario,
  nextJsTemplateStagedStatefulWorkflowScenario,
  nextJsTemplateLongRunningStatefulWorkflowScenario,
];

export function getMountaintopScenarioById(id: string): MountaintopScenario | undefined {
  return MOUNTAINTOP_SCENARIOS.find((scenario) => scenario.id === id);
}
