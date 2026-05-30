import type { AutonomousPlanReport, PlanStep, TaskItem } from '../types';

export class PlanController {
  createReport(goal: string, tasks: TaskItem[], completedTaskIds: string[], failedTaskIds: string[]): AutonomousPlanReport {
    const completed = new Set(completedTaskIds);
    const failed = new Set(failedTaskIds);
    const steps: PlanStep[] = tasks.map(task => ({
      id: task.id,
      title: task.title,
      status: failed.has(task.id)
        ? 'blocked'
        : completed.has(task.id)
          ? 'completed'
          : task.status === 'in_progress'
            ? 'in_progress'
            : 'pending',
      evidence: [
        task.result ? `Result: ${task.result}` : '',
        task.error ? `Error: ${task.error}` : '',
        task.reviewResult ? `Review: ${task.reviewResult.needsFix ? 'needs fix' : 'approved'}` : '',
      ].filter(Boolean),
      nextAction: task.status === 'failed'
        ? 'Inspect diagnostics and create a targeted fix task.'
        : task.status === 'pending'
          ? task.description
          : undefined,
    }));

    const currentStep = steps.find(step => step.status === 'in_progress')?.id
      ?? steps.find(step => step.status === 'pending')?.id;

    return {
      generatedAt: new Date().toISOString(),
      goal,
      steps,
      currentStep,
      summary: this._summarize(steps),
    };
  }

  nextAction(report: AutonomousPlanReport): string {
    const current = report.steps.find(step => step.id === report.currentStep);
    if (!current) {
      return 'All planned steps are complete or blocked; run verification and replan from diagnostics.';
    }
    return current.nextAction ?? `Continue step ${current.id}: ${current.title}`;
  }

  private _summarize(steps: PlanStep[]): string {
    const completed = steps.filter(step => step.status === 'completed').length;
    const blocked = steps.filter(step => step.status === 'blocked').length;
    const active = steps.filter(step => step.status === 'in_progress').length;
    const pending = steps.filter(step => step.status === 'pending').length;
    return `${completed} completed, ${active} active, ${pending} pending, ${blocked} blocked.`;
  }
}
