// ──────────────────────────────────────────────
// SenseVoice transcript post-processing (pure)
// ──────────────────────────────────────────────
// sherpa-onnx already performs FBank → CTC greedy → tokens.txt detokenization
// and returns a JSON result. SenseVoice bakes special tags into that text:
//   language: <|zh|> <|en|> <|ja|> <|ko|> <|yue|> <|nospeech|>
//   emotion:  <|HAPPY|> <|SAD|> <|ANGRY|> <|NEUTRAL|> …
//   event:    <|Speech|> <|BGM|> <|Applause|> <|Laughter|> …
//   itn:      <|withitn|> <|woitn|>
// Non-goal (R22): emotion/event tags — strip them all from the transcript.

/** Strip ALL SenseVoice `<|...|>` special tokens and normalize whitespace. */
const stripSenseVoiceTokens = (raw: string): string =>
  raw
    // remove any <|...|> tag (language / emotion / event / itn markers)
    .replace(/<\|[^|]*\|>/g, '')
    // SentencePiece word-boundary marker → space
    .replace(/\u2581/g, ' ')
    // collapse runs of whitespace introduced by tag removal
    .replace(/\s+/g, ' ')
    .trim();

export { stripSenseVoiceTokens };
