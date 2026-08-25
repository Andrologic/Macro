import React from 'react';
import type { SpeechDictationPhase } from '../../hooks/useSpeechDictation';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';

interface SpeechDictationButtonProps {
  phase: SpeechDictationPhase;
  elapsedSeconds: number;
  disabled: boolean;
  label: string;
  recordingLabel: string;
  transcribingLabel: string;
  onToggle: () => void;
}

const formatElapsed = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export const SpeechDictationButton: React.FC<SpeechDictationButtonProps> = ({
  phase,
  elapsedSeconds,
  disabled,
  label,
  recordingLabel,
  transcribingLabel,
  onToggle,
}) => {
  const isRecording = phase === 'recording';
  const isTranscribing =
    phase === 'transcribing' || phase === 'enhancing' || phase === 'requesting-permission';
  const accessibleLabel = isRecording
    ? `${recordingLabel} ${formatElapsed(elapsedSeconds)}`
    : isTranscribing
      ? transcribingLabel
      : label;

  return (
    <button
      type="button"
      data-tour-id="chat-dictation-button"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      disabled={(disabled || isTranscribing) && !isRecording}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className={cn(
        'relative flex h-9 min-w-9 items-center justify-center rounded-lg px-2 transition-colors',
        isRecording
          ? 'bg-red-500 text-white hover:bg-red-600'
          : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
        (disabled || isTranscribing) && !isRecording && 'cursor-not-allowed opacity-50',
      )}
    >
      {isTranscribing ? (
        <SpinnerIcon size={14} />
      ) : isRecording ? (
        <>
          <span className="absolute inset-0 animate-pulse rounded-lg bg-red-400/30" />
          <Icon name="square" size={13} className="relative" />
        </>
      ) : (
        <Icon name="mic" size={16} />
      )}
      {isRecording && (
        <span className="ml-1.5 text-[10px] tabular-nums">{formatElapsed(elapsedSeconds)}</span>
      )}
    </button>
  );
};
