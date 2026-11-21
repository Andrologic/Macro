import type { DegradedErrorTranslator } from './degradedErrorPresentation';

/** Translate only known task refusals, preserving unknown diagnostic messages. */
export const localizeTaskErrorMessage = (
  message: string,
  translate: DegradedErrorTranslator,
): string => {
  if (message === 'Database is locked'
    || message === 'Database error: error returned from database: (code: 5) database is locked') {
    return translate('implement.errors.databaseLocked', {
      defaultValue: 'The database is locked. Try again.',
    });
  }
  const activeTask = /^Direct-edit project already has an active task: ([\s\S]+)$/.exec(message);
  if (activeTask) {
    return translate('implement.errors.directProjectTaskAlreadyActiveWithTitle', {
      defaultValue: 'This direct-edit project already has an active task: {{title}}',
      title: activeTask[1],
    });
  }
  const openTodos = /^Cannot complete task while todos remain open(?:: ([\s\S]+))?$/.exec(message);
  if (openTodos) {
    return openTodos[1]
      ? translate('implement.errors.taskTodosOpenForComplete', {
          defaultValue: 'Cannot complete task while todos remain open: {{todos}}',
          todos: openTodos[1],
        })
      : translate('implement.errors.taskTodosOpenForCompleteWithoutLabels', {
          defaultValue: 'Cannot complete task while todos remain open',
        });
  }
  return message;
};
