import type React from "react";
import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import { theme } from "../theme/tokens.js";
import { buildVisibleEditableTextInputRows } from "./textInputLayout.js";

export interface ThemedTextInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly placeholder?: string;
  readonly focus?: boolean;
  readonly mask?: string;
  readonly showCursor?: boolean;
  readonly highlightPastedText?: boolean;
  readonly width?: number;
  readonly maxRows?: number;
}

export interface ThemedTextInputEditKey {
  readonly escape?: boolean | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
  readonly tab?: boolean | undefined;
  readonly return?: boolean | undefined;
  readonly leftArrow?: boolean | undefined;
  readonly rightArrow?: boolean | undefined;
  readonly upArrow?: boolean | undefined;
  readonly downArrow?: boolean | undefined;
  readonly pageUp?: boolean | undefined;
  readonly pageDown?: boolean | undefined;
  readonly backspace?: boolean | undefined;
  readonly delete?: boolean | undefined;
  readonly f1?: boolean | undefined;
}

export function shouldThemedTextInputIgnoreKey(key: ThemedTextInputEditKey): boolean {
  return Boolean(
    key.ctrl ||
      key.meta ||
      key.escape ||
      key.tab ||
      key.upArrow ||
      key.downArrow ||
      key.pageUp ||
      key.pageDown ||
      key.f1,
  );
}

export function resolveThemedTextInputEdit(input: {
  readonly value: string;
  readonly cursorOffset: number;
  readonly rawInput: string;
  readonly key: ThemedTextInputEditKey;
  readonly showCursor: boolean;
}): {
  readonly value: string;
  readonly cursorOffset: number;
  readonly cursorWidth: number;
} {
  let nextCursorOffset = input.cursorOffset;
  let nextValue = input.value;
  let nextCursorWidth = 0;

  if (input.key.leftArrow) {
    if (input.showCursor) {
      nextCursorOffset--;
    }
  } else if (input.key.rightArrow) {
    if (input.showCursor) {
      nextCursorOffset++;
    }
  } else if (input.key.backspace || input.key.delete) {
    if (input.cursorOffset > 0) {
      nextValue = input.value.slice(0, input.cursorOffset - 1) + input.value.slice(input.cursorOffset);
      nextCursorOffset--;
    }
  } else {
    nextValue = input.value.slice(0, input.cursorOffset) + input.rawInput + input.value.slice(input.cursorOffset);
    nextCursorOffset += input.rawInput.length;
    if (input.rawInput.length > 1) {
      nextCursorWidth = input.rawInput.length;
    }
  }

  if (nextCursorOffset < 0) {
    nextCursorOffset = 0;
  }
  if (nextCursorOffset > nextValue.length) {
    nextCursorOffset = nextValue.length;
  }

  return {
    value: nextValue,
    cursorOffset: nextCursorOffset,
    cursorWidth: nextCursorWidth,
  };
}

export function ThemedTextInput({
  value: originalValue,
  onChange,
  onSubmit,
  placeholder = "",
  focus = true,
  mask,
  showCursor = true,
  highlightPastedText = false,
  width,
  maxRows = 1,
}: ThemedTextInputProps): React.JSX.Element {
  const [state, setState] = useState({
    cursorOffset: originalValue.length,
    cursorWidth: 0,
  });
  const { cursorOffset, cursorWidth } = state;

  useEffect(() => {
    setState((previousState) => {
      if (!(focus && showCursor)) {
        return previousState;
      }

      if (previousState.cursorOffset > originalValue.length - 1) {
        return {
          cursorOffset: originalValue.length,
          cursorWidth: 0,
        };
      }

      return previousState;
    });
  }, [originalValue, focus, showCursor]);

  useInput((input, key) => {
    if (shouldThemedTextInputIgnoreKey(key)) {
      return;
    }

    if (key.return) {
      onSubmit?.(originalValue);
      return;
    }

    const edit = resolveThemedTextInputEdit({
      value: originalValue,
      cursorOffset,
      rawInput: input,
      key,
      showCursor,
    });

    setState({ cursorOffset: edit.cursorOffset, cursorWidth: edit.cursorWidth });
    if (edit.value !== originalValue) {
      onChange(edit.value);
    }
  }, { isActive: focus });

  const displayValue = mask === undefined ? originalValue : mask.repeat(originalValue.length);
  if (displayValue.length === 0 && placeholder.length > 0) {
    return (
      <ThemedInputText
        text={placeholder}
        color={theme.muted}
        cursorStart={showCursor && focus ? 0 : -1}
        cursorEnd={showCursor && focus ? 0 : -1}
      />
    );
  }

  const cursorActualWidth = highlightPastedText ? cursorWidth : 0;
  const cursorStart = showCursor && focus ? cursorOffset - cursorActualWidth : -1;
  const cursorEnd = showCursor && focus ? cursorOffset : -1;
  const visibleRows = width === undefined || maxRows <= 1
    ? undefined
    : buildVisibleEditableTextInputRows({
      text: displayValue,
      width,
      maxRows,
      cursorOffset,
    });

  if (visibleRows !== undefined) {
    return (
      <Box flexDirection="column" height={visibleRows.length} overflow="hidden" width={width}>
        {visibleRows.map((row, rowIndex) => {
          const cursorInRow = rowContainsCursor(visibleRows, rowIndex, cursorOffset);
          const rowCursorStart = cursorInRow
            ? resolveRowCursorOffset({
              rowStartOffset: row.startOffset,
              rowEndOffset: row.endOffset,
              rowTextLength: row.text.length,
              cursorOffset: cursorStart,
            })
            : -1;
          const rowCursorEnd = cursorInRow
            ? resolveRowCursorOffset({
              rowStartOffset: row.startOffset,
              rowEndOffset: row.endOffset,
              rowTextLength: row.text.length,
              cursorOffset: cursorEnd,
            })
            : -1;
          return (
            <ThemedInputText
              key={`${row.startOffset}-${row.endOffset}-${rowIndex}`}
              text={row.text}
              color={theme.text}
              cursorStart={rowCursorStart}
              cursorEnd={rowCursorEnd}
              appendCursor={
                cursorInRow &&
                showCursor &&
                focus &&
                displayValue.length > 0 &&
                cursorOffset >= row.startOffset + row.text.length
              }
            />
          );
        })}
      </Box>
    );
  }

  return (
    <ThemedInputText
      text={displayValue}
      color={theme.text}
      cursorStart={cursorStart}
      cursorEnd={cursorEnd}
      appendCursor={showCursor && focus && displayValue.length > 0 && cursorOffset === displayValue.length}
    />
  );
}

function resolveRowCursorOffset(input: {
  readonly rowStartOffset: number;
  readonly rowEndOffset: number;
  readonly rowTextLength: number;
  readonly cursorOffset: number;
}): number {
  if (input.cursorOffset < input.rowStartOffset || input.cursorOffset > input.rowEndOffset) {
    return -1;
  }
  return Math.max(0, Math.min(input.rowTextLength, input.cursorOffset - input.rowStartOffset));
}

function rowContainsCursor(
  rows: readonly { readonly startOffset: number; readonly endOffset: number }[],
  rowIndex: number,
  cursorOffset: number,
): boolean {
  const row = rows[rowIndex];
  if (row === undefined) {
    return false;
  }
  const nextRow = rows[rowIndex + 1];
  return (
    cursorOffset >= row.startOffset &&
    (cursorOffset < row.endOffset || (cursorOffset === row.endOffset && nextRow?.startOffset !== cursorOffset))
  );
}

function ThemedInputText(props: {
  readonly text: string;
  readonly color: string;
  readonly cursorStart: number;
  readonly cursorEnd: number;
  readonly appendCursor?: boolean;
}): React.JSX.Element {
  const segments: React.ReactNode[] = [];
  const chars = Array.from(props.text);

  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (index >= props.cursorStart && index <= props.cursorEnd) {
      segments.push(<Text key={`cursor-${index}`} inverse>{char}</Text>);
    } else {
      segments.push(char);
    }
  }

  if (props.text.length === 0 && props.cursorStart === 0) {
    segments.push(<Text key="cursor-empty" inverse> </Text>);
  } else if (props.appendCursor === true) {
    segments.push(<Text key="cursor-end" inverse> </Text>);
  }

  return <Text color={props.color}>{segments}</Text>;
}
