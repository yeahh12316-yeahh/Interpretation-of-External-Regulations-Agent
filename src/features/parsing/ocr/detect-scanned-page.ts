export const LOW_TEXT_CHARACTER_THRESHOLD = 12;

export const extractedCharacterCount = (text: string): number =>
  text.replace(/\s/g, "").length;

export const isScannedPage = (
  extractedText: string,
  threshold = LOW_TEXT_CHARACTER_THRESHOLD,
): boolean => extractedCharacterCount(extractedText) < threshold;
