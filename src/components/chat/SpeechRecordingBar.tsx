import React, { useEffect, useRef } from 'react';
import type {
  SpeechDictationCompletion,
  SpeechDictationPhase,
} from '../../hooks/useSpeechDictation';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';

interface SpeechRecordingBarProps {
  phase: Extract<SpeechDictationPhase, 'recording' | 'transcribing'>;
  completion: SpeechDictationCompletion | null;
  elapsedSeconds: number;
  getAudioLevel: () => number;
  recordingLabel: string;
  transcribingLabel: string;
  stopLabel: string;
  sendLabel: string;
  onStop: () => void;
  onSend: () => void;
}

const formatElapsed = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const drawWaveform = (
  canvas: HTMLCanvasElement,
  samples: number[],
) => {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const pixelRatio = window.devicePixelRatio || 1;
  const renderWidth = Math.floor(width * pixelRatio);
  const renderHeight = Math.floor(height * pixelRatio);
  if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
    canvas.width = renderWidth;
    canvas.height = renderHeight;
  }

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  const color = window.getComputedStyle(canvas).color || 'rgb(229, 231, 235)';
  const centerY = height / 2;

  context.strokeStyle = color;
  context.globalAlpha = 0.2;
  context.lineWidth = 1;
  context.setLineDash([2, 4]);
  context.beginPath();
  context.moveTo(0, centerY);
  context.lineTo(width, centerY);
  context.stroke();

  context.globalAlpha = 0.82;
  context.lineWidth = 2;
  context.lineCap = 'round';
  context.setLineDash([]);
  const gap = width / Math.max(1, samples.length);
  samples.forEach((sample, index) => {
    const x = gap * index + gap / 2;
    const barHeight = Math.max(2, sample * (height - 4));
    context.beginPath();
    context.moveTo(x, centerY - barHeight / 2);
    context.lineTo(x, centerY + barHeight / 2);
    context.stroke();
  });
  context.globalAlpha = 1;
};

export const SpeechRecordingBar: React.FC<SpeechRecordingBarProps> = ({
  phase,
  completion,
  elapsedSeconds,
  getAudioLevel,
  recordingLabel,
  transcribingLabel,
  stopLabel,
  sendLabel,
  onStop,
  onSend,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getAudioLevelRef = useRef(getAudioLevel);
  const samplesRef = useRef<number[]>(Array.from({ length: 72 }, () => 0.035));

  useEffect(() => {
    getAudioLevelRef.current = getAudioLevel;
  }, [getAudioLevel]);

  useEffect(() => {
    let animationFrame = 0;
    let lastSampleAt = 0;
    const animate = (now: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const sampleCount = Math.max(32, Math.floor(canvas.clientWidth / 6));
      if (samplesRef.current.length !== sampleCount) {
        const retained = samplesRef.current.slice(-sampleCount);
        samplesRef.current = [
          ...Array.from({ length: Math.max(0, sampleCount - retained.length) }, () => 0.035),
          ...retained,
        ];
      }
      if (now - lastSampleAt >= 45) {
        const level = Math.max(0.035, Math.min(1, getAudioLevelRef.current()));
        samplesRef.current.shift();
        samplesRef.current.push(level);
        lastSampleAt = now;
      }
      drawWaveform(canvas, samplesRef.current);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [phase]);

  const isProcessing = phase !== 'recording';
  const statusLabel = phase === 'transcribing'
    ? transcribingLabel
    : `${recordingLabel} ${formatElapsed(elapsedSeconds)}`;

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-2"
      data-tour-id="chat-dictation-recording-bar"
      data-phase={phase}
    >
      {phase === 'recording' ? (
        <>
          <span className="sr-only" aria-live="polite">{statusLabel}</span>
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="h-8 w-0 min-w-0 flex-1 text-foreground"
          />
          <span className="w-10 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
            {formatElapsed(elapsedSeconds)}
          </span>
        </>
      ) : (
        <div
          className="flex h-8 w-0 min-w-0 flex-1 items-center gap-2.5 px-1 text-muted-foreground"
          data-testid="speech-processing-state"
          aria-live="polite"
        >
          <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
            <span className="absolute inset-0 animate-spin rounded-lg border border-current border-r-transparent opacity-50" />
            <Icon
              name="arrow-up"
              size={12}
              className="animate-pulse"
            />
          </span>
          <span className="truncate text-xs">{statusLabel}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="h-1 w-1 animate-pulse rounded-full bg-current"
                style={{ animationDelay: `${index * 160}ms` }}
              />
            ))}
          </span>
        </div>
      )}
      <button
        type="button"
        aria-label={stopLabel}
        title={stopLabel}
        disabled={isProcessing}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onStop}
        className={cn(
          'flex h-9 min-w-9 shrink-0 items-center justify-center rounded-lg bg-muted px-2 text-foreground transition-colors',
          isProcessing ? 'cursor-wait opacity-70' : 'hover:bg-accent',
        )}
      >
        {isProcessing && completion === 'insert' ? (
          <SpinnerIcon size={14} />
        ) : (
          <Icon name="square" size={12} className="fill-current" />
        )}
      </button>
      <button
        type="button"
        aria-label={sendLabel}
        title={sendLabel}
        disabled={isProcessing}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSend}
        className={cn(
          'flex h-9 min-w-9 shrink-0 items-center justify-center rounded-lg bg-primary px-3 text-primary-foreground transition-colors',
          isProcessing ? 'cursor-wait opacity-70' : 'hover:bg-primary/90',
        )}
      >
        {isProcessing && completion === 'send' ? (
          <SpinnerIcon size={14} />
        ) : (
          <Icon name="arrow-up" size={15} />
        )}
      </button>
    </div>
  );
};
