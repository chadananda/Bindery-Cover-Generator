// Core cover-generation logic — zero dependencies, runs in a browser, a Worker or Node.
// Copy this folder to reuse the generator without the app. See core/README.md.
export { keyOut, sampleBackground, aspectOk, ASPECT_RANGE } from './keyer.js';
export { composePrompt, composeEditPrompt, composeBasedOnPrompt, retitlePrompt, isGenerationPrompt, bylineOf, effectiveStyles, keyColor, KEY_COLORS, DEFAULT_APP_STYLE } from './prompt.js';
export { parseCsv, csvToBooks } from './csv.js';
export { generateImage, DEFAULT_MODEL } from './gemini.js';
export { snapshotStyles, sameStyles, applyStyles, nextLookName } from './looks.js';
