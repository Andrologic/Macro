import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationQuestionnaireState } from '../../types';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Input } from '../ui/Input';

interface QuestionnaireFooterProps {
  activeQuestionnaire: ConversationQuestionnaireState;
  draftText: string;
  selectedChoice: string;
  submitValue: string;
  hasPreviousStep: boolean;
  hasNextStep: boolean;
  isBusySending: boolean;
  onAnswer: (answer: string) => Promise<void>;
  onSubmit: () => Promise<void>;
  onStepChange: (stepIndex: number) => void;
  onDraftTextChange: (value: string) => void;
  onCancel: () => void;
}

export const QuestionnaireFooter: React.FC<QuestionnaireFooterProps> = ({
  activeQuestionnaire,
  draftText,
  selectedChoice,
  submitValue,
  hasPreviousStep,
  hasNextStep,
  isBusySending,
  onAnswer,
  onSubmit,
  onStepChange,
  onDraftTextChange,
  onCancel,
}) => {
  const { t } = useTranslation();

  return (
    <div
      data-testid="questionnaire-footer"
      className="space-y-3 rounded-xl border border-border bg-card/80 px-3 py-3 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-border/50">
            <Icon name="message-circle-question" size={14} className="text-primary/80" />
          </span>
          <div className="flex h-8 min-w-0 items-center gap-2.5">
            <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t('chat.questionnaireLabel', 'Question')}
            </div>
            <div
              data-testid="questionnaire-step-counter-shell"
              className="inline-flex items-center gap-0 rounded-full border border-border/60 bg-background/45 px-[2px] py-[2px]"
            >
              {activeQuestionnaire.totalSteps > 1 && (
                <button
                  type="button"
                  data-testid="questionnaire-step-nav-prev"
                  onClick={() => onStepChange(activeQuestionnaire.currentStepIndex - 1)}
                  disabled={isBusySending || !hasPreviousStep}
                  title={t('chat.questionnairePreviousStep', 'Question precedente')}
                  aria-label={t('chat.questionnairePreviousStep', 'Question precedente')}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/75 transition-colors hover:bg-accent/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-25"
                >
                  <Icon name="chevron-left" size={12} />
                </button>
              )}
              <div
                data-testid="questionnaire-step-counter"
                className="px-1 text-center text-[11px] font-medium tabular-nums text-muted-foreground"
              >
                {`${activeQuestionnaire.currentStepIndex + 1}/${activeQuestionnaire.totalSteps}`}
              </div>
              {activeQuestionnaire.totalSteps > 1 && (
                <button
                  type="button"
                  data-testid="questionnaire-step-nav-next"
                  onClick={() => onStepChange(activeQuestionnaire.currentStepIndex + 1)}
                  disabled={isBusySending || !hasNextStep}
                  title={t('chat.questionnairePeekNextStep', 'Question suivante')}
                  aria-label={t('chat.questionnairePeekNextStep', 'Question suivante')}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/75 transition-colors hover:bg-accent/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-25"
                >
                  <Icon name="chevron-right" size={12} />
                </button>
              )}
            </div>
            <div className="sr-only">
              {t('chat.questionnaireProgress', 'Question {{current}}/{{total}}', {
                current: activeQuestionnaire.currentStepIndex + 1,
                total: activeQuestionnaire.totalSteps,
              })}
            </div>
          </div>
        </div>
        <span className="inline-flex items-center rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-[11px] text-muted-foreground">
          {t('chat.questionnaireFreeTextHint', 'Choose one option or answer freely')}
        </span>
      </div>

      <div
        key={`${activeQuestionnaire.assistantMessageId}-${activeQuestionnaire.currentStepIndex}-${activeQuestionnaire.currentStep.id}`}
        data-testid="questionnaire-step-panel"
        className="questionnaire-step-enter space-y-3"
      >
        <p className="pr-1 text-[1.02rem] font-semibold leading-7 text-foreground text-balance">
          {activeQuestionnaire.currentStep.prompt}
        </p>

        <div
          data-testid="questionnaire-choice-list"
          className="flex flex-col gap-2"
        >
          {activeQuestionnaire.currentStep.choices.map((choice) => {
            const isSelected = selectedChoice === choice;
            return (
              <Button
                key={choice}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void onAnswer(choice)}
                disabled={isBusySending}
                className={cn(
                  'h-auto min-h-[52px] w-full justify-start rounded-xl border px-3 py-3 text-left text-sm whitespace-normal',
                  isBusySending
                    ? 'border-border bg-muted/40 text-muted-foreground'
                    : isSelected
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border/70 bg-background/45 text-foreground hover:border-primary/40 hover:bg-accent/60'
                )}
              >
                {choice}
              </Button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <Input
            type="text"
            value={draftText}
            onChange={(event) => onDraftTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void onSubmit();
              }
            }}
            placeholder={
              activeQuestionnaire.currentStep.free_text_placeholder ||
              t('chat.questionnaireFreeTextPlaceholder', 'Or type your own answer')
            }
            disabled={isBusySending}
            className="h-11 flex-1 border-border/70 bg-background/60"
          />
          {activeQuestionnaire.mode === 'editing_response' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              className="h-11 shrink-0 rounded-xl border border-border/70 px-4"
            >
              {t('common.cancel', 'Annuler')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => void onSubmit()}
            disabled={isBusySending || submitValue.trim().length === 0}
            className="h-11 shrink-0 rounded-xl px-4"
          >
            {activeQuestionnaire.isLastStep
              ? t('chat.questionnaireSubmit', 'Envoyer')
              : t('chat.questionnaireNext', 'Suivant')}
          </Button>
        </div>
      </div>
    </div>
  );
};
