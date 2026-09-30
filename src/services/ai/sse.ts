
export const extractSseData = (rawEvent: string): string | undefined => {
  const dataLines = rawEvent.split('\n').flatMap((rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) {
      return [];
    }
    const data = line.slice('data:'.length);
    return [data.startsWith(' ') ? data.slice(1) : data];
  });

  return dataLines.length > 0 ? dataLines.join('\n') : undefined;
};

export interface SseEventParser {
  push(chunk: string): string[];
  flush(): string[];
}

export const createSseEventParser = (): SseEventParser => {
  let input = '';
  let eventLines: string[] = [];

  const dispatchEvent = (events: string[]) => {
    if (eventLines.length > 0) {
      events.push(eventLines.join('\n'));
      eventLines = [];
    }
  };

  const drain = (flush: boolean): string[] => {
    const events: string[] = [];
    while (true) {
      const newlineIndex = input.indexOf('\n');
      const carriageReturnIndex = input.indexOf('\r');
      let lineEnd = -1;
      let terminatorLength = 0;

      if (newlineIndex >= 0 && carriageReturnIndex >= 0) {
        lineEnd = Math.min(newlineIndex, carriageReturnIndex);
      } else {
        lineEnd = Math.max(newlineIndex, carriageReturnIndex);
      }

      if (lineEnd < 0) {
        break;
      }
      if (input[lineEnd] === '\r' && lineEnd === input.length - 1 && !flush) {
        break;
      }

      if (input[lineEnd] === '\r' && input[lineEnd + 1] === '\n') {
        terminatorLength = 2;
      } else {
        terminatorLength = 1;
      }

      const line = input.slice(0, lineEnd);
      input = input.slice(lineEnd + terminatorLength);
      if (line.length === 0) {
        dispatchEvent(events);
      } else {
        eventLines.push(line);
      }
    }

    if (flush && input.length > 0) {
      eventLines.push(input);
      input = '';
    }
    if (flush) {
      dispatchEvent(events);
    }

    return events;
  };

  return {
    push(chunk: string) {
      input += chunk;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
  };
};
