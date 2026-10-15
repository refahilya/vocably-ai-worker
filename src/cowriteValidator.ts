/**
 * Deterministic Co-Write validation — TypeScript mirror of the Flutter
 * client's `lib/utils/cowrite_validator.dart` (sibling `vocably` repo).
 * Both sides must keep identical semantics; any change here must be made
 * there too, with the same regression cases (test/cowriteValidator.test.ts
 * vs. test/utils/cowrite_validator_test.dart).
 *
 * Worker-only addition (no Dart counterpart, because only the Worker sees
 * raw model output before it is returned): `isEchoOfStudentTurn`.
 * `extractSuggestedSentence` is mirrored in Dart
 * (`lib/utils/cowrite_suggestion.dart`) as a defensive fallback for
 * responses from an older deployed Worker.
 */

const WORD_TOKEN_REGEX = /[a-zA-Z]+(?:'[a-zA-Z]+)?/g;
const LIST_SEPARATOR_REGEX = /[,;/]/;

const DETERMINERS = new Set([
  'a', 'an', 'the', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'this', 'that', 'these', 'those', 'some', 'any', 'no', 'every', 'each',
]);

const SINGULAR_DEMONSTRATIVES = new Set(['this', 'that']);
const PLURAL_DEMONSTRATIVES = new Set(['these', 'those']);

const PREPOSITIONS = new Set([
  'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'of', 'about',
  'into', 'over', 'after', 'before', 'under', 'between', 'through',
]);

const LIST_FILLERS = new Set(['a', 'an', 'the', 'and', 'or']);

const COMPARATIVE_LEAD_INS = new Set([
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'become', 'becomes', 'became', 'becoming',
  'get', 'gets', 'got', 'getting', 'grow', 'grows', 'grew', 'growing',
  'look', 'looks', 'looked', 'feel', 'feels', 'felt', 'seem', 'seems', 'seemed',
  'much', 'even', 'far', 'slightly', 'lot', 'bit', 'little',
]);

const SUPERLATIVE_LEAD_INS = new Set([
  'the', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
]);

/** `lie` deliberately does not list `lay` — see the Dart mirror. */
const IRREGULAR_FORMS: Record<string, readonly string[]> = {
  be: ['am', 'is', 'are', 'was', 'were', 'been', 'being'],
  have: ['has', 'had', 'having'],
  do: ['does', 'did', 'done', 'doing'],
  go: ['goes', 'went', 'gone', 'going'],
  say: ['said', 'says', 'saying'],
  run: ['ran', 'running', 'runs'],
  eat: ['ate', 'eaten', 'eating', 'eats'],
  drink: ['drank', 'drunk', 'drinking', 'drinks'],
  see: ['saw', 'seen', 'seeing', 'sees'],
  take: ['took', 'taken', 'taking', 'takes'],
  give: ['gave', 'given', 'giving', 'gives'],
  make: ['made', 'making', 'makes'],
  come: ['came', 'coming', 'comes'],
  know: ['knew', 'known', 'knowing', 'knows'],
  get: ['got', 'gotten', 'getting', 'gets'],
  find: ['found', 'finding', 'finds'],
  think: ['thought', 'thinking', 'thinks'],
  tell: ['told', 'telling', 'tells'],
  become: ['became', 'becoming', 'becomes'],
  show: ['showed', 'shown', 'showing', 'shows'],
  leave: ['left', 'leaving', 'leaves'],
  feel: ['felt', 'feeling', 'feels'],
  put: ['putting', 'puts'],
  bring: ['brought', 'bringing', 'brings'],
  begin: ['began', 'begun', 'beginning', 'begins'],
  keep: ['kept', 'keeping', 'keeps'],
  hold: ['held', 'holding', 'holds'],
  write: ['wrote', 'written', 'writing', 'writes'],
  stand: ['stood', 'standing', 'stands'],
  hear: ['heard', 'hearing', 'hears'],
  let: ['letting', 'lets'],
  mean: ['meant', 'meaning', 'means'],
  set: ['setting', 'sets'],
  meet: ['met', 'meeting', 'meets'],
  pay: ['paid', 'paying', 'pays'],
  sit: ['sat', 'sitting', 'sits'],
  speak: ['spoke', 'spoken', 'speaking', 'speaks'],
  lie: ['lain', 'lying', 'lies', 'lied'],
  lead: ['led', 'leading', 'leads'],
  read: ['reading', 'reads'],
  grow: ['grew', 'grown', 'growing', 'grows'],
  lose: ['lost', 'losing', 'loses'],
  fall: ['fell', 'fallen', 'falling', 'falls'],
  send: ['sent', 'sending', 'sends'],
  build: ['built', 'building', 'builds'],
  understand: ['understood', 'understanding', 'understands'],
  draw: ['drew', 'drawn', 'drawing', 'draws'],
  break: ['broke', 'broken', 'breaking', 'breaks'],
  spend: ['spent', 'spending', 'spends'],
  cut: ['cutting', 'cuts'],
  rise: ['rose', 'risen', 'rising', 'rises'],
  drive: ['drove', 'driven', 'driving', 'drives'],
  buy: ['bought', 'buying', 'buys'],
  wear: ['wore', 'worn', 'wearing', 'wears'],
  choose: ['chose', 'chosen', 'choosing', 'chooses'],
  seek: ['sought', 'seeking', 'seeks'],
  throw: ['threw', 'thrown', 'throwing', 'throws'],
  catch: ['caught', 'catching', 'catches'],
  deal: ['dealt', 'dealing', 'deals'],
  win: ['won', 'winning', 'wins'],
  forget: ['forgot', 'forgotten', 'forgetting', 'forgets'],
  forgive: ['forgave', 'forgiven', 'forgiving', 'forgives'],
  lay: ['laid', 'laying', 'lays'],
  sell: ['sold', 'selling', 'sells'],
  fight: ['fought', 'fighting', 'fights'],
  teach: ['taught', 'teaching', 'teaches'],
  sing: ['sang', 'sung', 'singing', 'sings'],
  strike: ['struck', 'striking', 'strikes'],
  hang: ['hung', 'hanged', 'hanging', 'hangs'],
  shake: ['shook', 'shaken', 'shaking', 'shakes'],
  ride: ['rode', 'ridden', 'riding', 'rides'],
  feed: ['fed', 'feeding', 'feeds'],
  shoot: ['shot', 'shooting', 'shoots'],
  fly: ['flew', 'flown', 'flying', 'flies'],
  wake: ['woke', 'woken', 'waking', 'wakes', 'waked'],
  sleep: ['slept', 'sleeping', 'sleeps'],
  sweep: ['swept', 'sweeping', 'sweeps'],
  swim: ['swam', 'swum', 'swimming', 'swims'],
  steal: ['stole', 'stolen', 'stealing', 'steals'],
  dig: ['dug', 'digging', 'digs'],
  hide: ['hid', 'hidden', 'hiding', 'hides'],
  shine: ['shone', 'shined', 'shining', 'shines'],
  tear: ['tore', 'torn', 'tearing', 'tears'],
  blow: ['blew', 'blown', 'blowing', 'blows'],
  ring: ['rang', 'rung', 'ringing', 'rings'],
  freeze: ['froze', 'frozen', 'freezing', 'freezes'],
  bite: ['bit', 'bitten', 'biting', 'bites'],
  hit: ['hitting', 'hits'],
  hurt: ['hurting', 'hurts'],
  cost: ['costing', 'costs'],
  shut: ['shutting', 'shuts'],
  lend: ['lent', 'lending', 'lends'],
  bend: ['bent', 'bending', 'bends'],
  light: ['lit', 'lighted', 'lighting', 'lights'],
  bleed: ['bled', 'bleeding', 'bleeds'],
  flee: ['fled', 'fleeing', 'flees'],
  stick: ['stuck', 'sticking', 'sticks'],
  swing: ['swung', 'swinging', 'swings'],
  sink: ['sank', 'sunk', 'sinking', 'sinks'],
  spin: ['spun', 'spinning', 'spins'],
  slide: ['slid', 'sliding', 'slides'],
  beat: ['beaten', 'beating', 'beats'],
  wind: ['wound', 'winding', 'winds'],
  weep: ['wept', 'weeping', 'weeps'],
  creep: ['crept', 'creeping', 'creeps'],
  swear: ['swore', 'sworn', 'swearing', 'swears'],
  arise: ['arose', 'arisen', 'arising', 'arises'],
  good: ['better', 'best'],
  bad: ['worse', 'worst'],
  child: ['children'],
  person: ['people', 'persons'],
  man: ['men'],
  woman: ['women'],
  foot: ['feet'],
  tooth: ['teeth'],
  mouse: ['mice'],
};

function isVowel(ch: string): boolean {
  return ch === 'a' || ch === 'e' || ch === 'i' || ch === 'o' || ch === 'u';
}

export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

export function extractWordTokens(text: string): string[] {
  const normalized = text.replace(/[’‘]/g, "'");
  const matches = normalized.match(WORD_TOKEN_REGEX);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

function takesEsSuffix(clean: string): boolean {
  return (
    clean.endsWith('s') ||
    clean.endsWith('x') ||
    clean.endsWith('z') ||
    clean.endsWith('o') ||
    clean.endsWith('ch') ||
    clean.endsWith('sh')
  );
}

/** Mirror of Dart `_doublesFinalConsonant`: consonant-vowel-consonant only. */
function doublesFinalConsonant(clean: string): boolean {
  const len = clean.length;
  if (len < 3) return false;
  const last = clean.charAt(len - 1);
  const prev = clean.charAt(len - 2);
  const before = clean.charAt(len - 3);
  if (isVowel(last) || last === 'w' || last === 'x' || last === 'y') return false;
  if (!isVowel(prev)) return false;
  if (!isVowel(before)) return true;
  return before === 'u' && len >= 4 && clean.charAt(len - 4) === 'q';
}

/**
 * Mirror of Dart `validFormsForSingleWord`: suffixes by spelling rule
 * (never `attackked`/`attackes`/`attackd`), and no generated regular past
 * for words with an irregular entry (`be` never yields `bed`).
 */
export function validFormsForSingleWord(base: string): Set<string> {
  const clean = normalizeWord(base);
  if (!clean) return new Set();

  const forms = new Set<string>([clean]);
  const irregular = IRREGULAR_FORMS[clean];
  for (const form of irregular ?? []) forms.add(form);
  const regularPast = irregular === undefined;

  const len = clean.length;
  const last = clean.charAt(len - 1);
  const prev = len >= 2 ? clean.charAt(len - 2) : '';

  if (last === 'e' && len > 2) {
    forms.add(`${clean}s`);
    if (regularPast) forms.add(`${clean}d`);
    if (prev === 'i') {
      forms.add(`${clean.slice(0, len - 2)}ying`);
    } else if (prev === 'e' || prev === 'o' || prev === 'y') {
      forms.add(`${clean}ing`);
    } else {
      forms.add(`${clean.slice(0, len - 1)}ing`);
    }
    if (len > 3 && prev === 'f') forms.add(`${clean.slice(0, len - 2)}ves`);
  } else if (last === 'y' && len > 2 && !isVowel(prev)) {
    const stem = clean.slice(0, len - 1);
    forms.add(`${stem}ies`);
    forms.add(`${clean}ing`);
    if (regularPast) forms.add(`${stem}ied`);
  } else {
    forms.add(`${clean}s`);
    forms.add(`${clean}ing`);
    if (regularPast) forms.add(`${clean}ed`);
    if (takesEsSuffix(clean)) forms.add(`${clean}es`);
    if (last === 'f' && len > 2) forms.add(`${clean.slice(0, len - 1)}ves`);
    if (last === 'c' && len > 2) {
      forms.add(`${clean}king`);
      if (regularPast) forms.add(`${clean}ked`);
    }
    if (doublesFinalConsonant(clean)) {
      forms.add(`${clean}${last}ing`);
      if (regularPast) forms.add(`${clean}${last}ed`);
    }
  }

  return forms;
}

function gradedForms(base: string, suffix: 'er' | 'est'): Set<string> {
  const clean = normalizeWord(base);
  const len = clean.length;
  if (len < 2) return new Set();

  const last = clean.charAt(len - 1);
  const prev = clean.charAt(len - 2);
  const forms = new Set<string>();

  if (last === 'e') {
    forms.add(`${clean.slice(0, len - 1)}${suffix}`);
  } else if (last === 'y' && !isVowel(prev)) {
    forms.add(`${clean.slice(0, len - 1)}i${suffix}`);
  } else {
    forms.add(`${clean}${suffix}`);
    if (
      len >= 3 &&
      !isVowel(last) &&
      last !== 'w' &&
      last !== 'x' &&
      last !== 'y' &&
      isVowel(prev) &&
      !isVowel(clean.charAt(len - 3))
    ) {
      forms.add(`${clean}${last}${suffix}`);
    }
  }
  return forms;
}

function stripPossessive(surfaceToken: string): string {
  let token = normalizeWord(surfaceToken).replace(/[’‘]/g, "'");
  if (token.endsWith("'s")) {
    token = token.slice(0, -2);
  } else if (token.endsWith("'")) {
    token = token.slice(0, -1);
  }
  return token;
}

export function matchesSingleWordForm(surfaceToken: string, targetBase: string): boolean {
  const token = stripPossessive(surfaceToken);
  if (!token) return false;
  return validFormsForSingleWord(targetBase).has(token);
}

function isBeContraction(token: string): boolean {
  return token.endsWith("'s") || token.endsWith("'re") || token.endsWith("'m");
}

function matchesGradedFormInContext(
  tokens: readonly string[],
  index: number,
  targetBase: string,
): boolean {
  const token = stripPossessive(tokens[index] ?? '');
  const previous = index > 0 ? tokens[index - 1] : undefined;
  const next = index + 1 < tokens.length ? tokens[index + 1] : undefined;

  if (gradedForms(targetBase, 'er').has(token)) {
    if (next === 'than') return true;
    if (previous !== undefined && (COMPARATIVE_LEAD_INS.has(previous) || isBeContraction(previous))) {
      return true;
    }
  }
  if (gradedForms(targetBase, 'est').has(token)) {
    if (previous !== undefined && SUPERLATIVE_LEAD_INS.has(previous)) return true;
  }
  return false;
}

export function containsTargetWordInText(text: string, targetWord: string): boolean {
  const targetTokens = extractWordTokens(targetWord);
  if (targetTokens.length === 0) return false;

  const textTokens = extractWordTokens(text);
  if (textTokens.length < targetTokens.length) return false;

  if (targetTokens.length === 1) {
    const targetSingle = targetTokens[0] ?? '';
    for (let i = 0; i < textTokens.length; i++) {
      if (matchesSingleWordForm(textTokens[i] ?? '', targetSingle)) return true;
      if (matchesGradedFormInContext(textTokens, i, targetSingle)) return true;
    }
    return false;
  }

  const windowLen = targetTokens.length;
  for (let i = 0; i <= textTokens.length - windowLen; i++) {
    let allMatch = true;
    for (let j = 0; j < windowLen; j++) {
      if (!matchesSingleWordForm(textTokens[i + j] ?? '', targetTokens[j] ?? '')) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }
  return false;
}

export function containsAnyTargetWord(text: string, targetWords: readonly string[]): boolean {
  return targetWords
    .map(normalizeWord)
    .filter((w) => w.length > 0)
    .some((target) => containsTargetWordInText(text, target));
}

function looksLikeThirdPersonVerb(token: string): boolean {
  return (
    token.length > 2 &&
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('us') &&
    !token.endsWith('is')
  );
}

function isDemonstrativeSubjectClause(first: string, second: string): boolean {
  if (SINGULAR_DEMONSTRATIVES.has(first)) {
    return looksLikeThirdPersonVerb(second) || second.endsWith('ed');
  }
  if (PLURAL_DEMONSTRATIVES.has(first)) {
    return second.endsWith('ed');
  }
  return false;
}

/** Same rules, same order, as `isBareOrFragmentTurn` in the Dart mirror. */
export function isBareOrFragmentTurn(text: string, targetWords: readonly string[]): boolean {
  const tokens = extractWordTokens(text);

  if (tokens.length < 2) return true;
  if (new Set(tokens).size === 1) return true;

  const first = tokens[0] ?? '';
  const second = tokens[1] ?? '';

  if (tokens.length === 2 && DETERMINERS.has(first) && !isDemonstrativeSubjectClause(first, second)) {
    return true;
  }
  if (tokens.length === 2 && PREPOSITIONS.has(first)) return true;
  if (tokens.length === 3 && PREPOSITIONS.has(first) && DETERMINERS.has(second)) return true;

  const normalizedTargets = new Set(targetWords.map(normalizeWord).filter((w) => w.length > 0));
  if (normalizedTargets.size > 0) {
    const contentTokens = tokens.filter((t) => !LIST_FILLERS.has(t));
    const targets = [...normalizedTargets];
    const allTargets =
      contentTokens.length > 0 &&
      contentTokens.every((token) => targets.some((target) => containsTargetWordInText(token, target)));
    if (allTargets) {
      const hasSeparator = LIST_SEPARATOR_REGEX.test(text);
      const noneInflected = contentTokens.every((token) => normalizedTargets.has(stripPossessive(token)));
      if (hasSeparator || noneInflected) return true;
    }
  }

  return false;
}

export function shouldRejectStudentTurnLocally(text: string, targetWords: readonly string[]): boolean {
  return containsAnyTargetWord(text, targetWords) && isBareOrFragmentTurn(text, targetWords);
}

/**
 * Mirror of Dart `_canonicalTargetsForClaim`: maps a model-reported word
 * (`attacked`, `Attack.`, `'attack'`, `"ATTACKS"`) to the eligible base
 * target(s) it denotes. Exact base form wins; otherwise every eligible
 * target whose inflections (or comparative/superlative forms) include it.
 */
function canonicalTargetsForClaim(raw: string, eligible: ReadonlySet<string>): string[] {
  const tokens = extractWordTokens(raw);
  if (tokens.length === 0) return [];
  const claim = tokens.join(' ');
  if (eligible.has(claim)) return [claim];

  const matches: string[] = [];
  for (const target of eligible) {
    const targetTokens = extractWordTokens(target);
    if (targetTokens.length !== tokens.length) continue;
    const allMatch = tokens.every((rawToken, i) => {
      const token = stripPossessive(rawToken);
      const base = targetTokens[i] ?? '';
      return (
        validFormsForSingleWord(base).has(token) ||
        gradedForms(base, 'er').has(token) ||
        gradedForms(base, 'est').has(token)
      );
    });
    if (allMatch) matches.push(target);
  }
  return matches;
}

/**
 * Mirror of Dart `validateStudentTargetWords`: the model judges meaning;
 * code requires each claim to map to a remaining target that occurs in the
 * student's text, in a turn that is not a bare word/fragment/list.
 */
export function validateStudentTargetWords(
  claimedWords: readonly string[],
  studentTurnText: string,
  eligibleTargetWords: readonly string[],
): string[] {
  const eligible = new Set(eligibleTargetWords.map(normalizeWord).filter((w) => w.length > 0));
  if (eligible.size === 0) return [];
  if (isBareOrFragmentTurn(studentTurnText, [...eligible])) return [];

  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of claimedWords) {
    for (const target of canonicalTargetsForClaim(raw, eligible)) {
      if (seen.has(target)) continue;
      if (!containsTargetWordInText(studentTurnText, target)) continue;
      seen.add(target);
      result.push(target);
    }
  }
  return result;
}

/** Mirror of Dart `validateBotTargetWords`. */
export function validateBotTargetWords(
  claimedWords: readonly string[],
  aiTurnText: string,
  eligibleTargetWords: readonly string[],
): string[] {
  const eligible = new Set(eligibleTargetWords.map(normalizeWord).filter((w) => w.length > 0));
  if (eligible.size === 0 || !aiTurnText.trim()) return [];

  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...claimedWords, ...eligibleTargetWords]) {
    const normalized = normalizeWord(raw);
    if (!normalized || seen.has(normalized)) continue;
    if (!eligible.has(normalized)) continue;
    if (!containsTargetWordInText(aiTurnText, normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Mirror of Dart `_indonesianStrongMarkers`: unambiguous Indonesian function
 * words, pronouns, and particles (none is an ordinary English word). English
 * homographs such as `main`, `data`, `jam`, `bank`, `ya`, `yuk`, `dong`,
 * `situ`, `agar` are deliberately excluded.
 */
const INDONESIAN_STRONG_MARKERS = new Set([
  'aku', 'saya', 'kamu', 'kau', 'ia', 'kami', 'kita', 'mereka', 'beliau',
  'yang', 'dengan', 'untuk', 'dari', 'ke', 'di', 'pada', 'dalam', 'oleh',
  'kepada', 'bagi', 'tentang', 'seperti', 'atau', 'lalu', 'kemudian',
  'karena', 'tetapi', 'tapi', 'jadi', 'kalau', 'jika', 'supaya', 'sehingga',
  'ini', 'itu', 'sini', 'sana',
  'tidak', 'bukan', 'belum', 'sudah', 'sedang', 'akan', 'telah', 'pernah',
  'masih', 'lagi', 'juga', 'saja', 'aja', 'hanya', 'sangat', 'sekali',
  'banget', 'gak', 'nggak', 'enggak',
  'adalah', 'bisa', 'ingin', 'harus', 'boleh', 'bantu', 'tolong', 'buat',
  'membuat', 'bikin',
  'siapa', 'bagaimana', 'kenapa', 'mengapa', 'kapan', 'dimana', 'berapa',
  'deh', 'sih', 'nih',
]);

/** Mirror of Dart `_indonesianWeakMarkers`: also English names/acronyms. */
const INDONESIAN_WEAK_MARKERS = new Set(['dan', 'ada', 'anda', 'dia', 'mau', 'apa']);

const CASE_SENSITIVE_WORD_REGEX = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

function isCapitalizedMidSentence(raw: string, text: string, start: number): boolean {
  const first = raw.charAt(0);
  if (first.toUpperCase() !== first || first.toLowerCase() === first) return false;
  for (let i = start - 1; i >= 0; i--) {
    const ch = text.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '"' || ch === "'" || ch === '(') continue;
    return !(ch === '.' || ch === '!' || ch === '?' || ch === ':');
  }
  return false;
}

/**
 * Mirror of Dart `containsIndonesianWords`: deterministic, application-owned
 * check for an Indonesian or mixed Indonesian-English text (>= 1 strong
 * marker, or >= 2 weak markers). Target words, mid-sentence capitalized words
 * (proper nouns), and `yang` next to `yin` never count. A heuristic, not
 * language identification. The Worker uses it only to reject an Indonesian
 * `aiTurn`; the student-turn classification comes from the client's
 * `studentTurnContainsIndonesian` flag.
 */
export function containsIndonesianWords(text: string, targetWords: readonly string[]): boolean {
  const normalizedTargets = targetWords.map(normalizeWord).filter((w) => w.length > 0);
  const normalizedText = text.replace(/[’‘]/g, "'");
  const hasYin = extractWordTokens(normalizedText).includes('yin');

  let strong = 0;
  let weak = 0;
  for (const match of normalizedText.matchAll(CASE_SENSITIVE_WORD_REGEX)) {
    const raw = match[0];
    const token = raw.toLowerCase();
    if (!INDONESIAN_STRONG_MARKERS.has(token) && !INDONESIAN_WEAK_MARKERS.has(token)) continue;
    if (normalizedTargets.some((t) => containsTargetWordInText(token, t))) continue;
    if (token === 'yang' && hasYin) continue;
    if (isCapitalizedMidSentence(raw, normalizedText, match.index ?? 0)) continue;

    if (INDONESIAN_STRONG_MARKERS.has(token)) strong++;
    else weak++;
  }
  return strong >= 1 || weak >= 2;
}

const ECHO_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'from', 'by', 'is', 'am', 'are', 'was', 'were', 'be', 'it', 'he', 'she',
  'they', 'we', 'i', 'you', 'his', 'her', 'their', 'my', 'your', 'our', 'its',
  'then', 'that', 'this', 'very', 'too', 'also',
]);

/**
 * Worker-only: whether `aiTurn` merely repeats/paraphrases `studentTurn`
 * instead of continuing the story — at least 75% of the AI turn's content
 * words already appear in the student's turn (needs >= 2 content words).
 * Deliberately conservative: a continuation that reuses a character name or
 * an object still adds new content words and passes.
 */
export function isEchoOfStudentTurn(aiTurn: string, studentTurn: string): boolean {
  const content = (text: string) =>
    extractWordTokens(text)
      .map(stripPossessive)
      .filter((t) => t.length > 0 && !ECHO_STOPWORDS.has(t));
  const aiContent = [...new Set(content(aiTurn))];
  if (aiContent.length < 2) return false;
  const studentContent = new Set(content(studentTurn));
  if (studentContent.size === 0) return false;
  const overlap = aiContent.filter((t) => studentContent.has(t)).length;
  return overlap / aiContent.length >= 0.75;
}

const SUGGESTION_PREFIX_REGEX =
  /^\s*(?:(?:you\s+(?:could|can|might)\s+(?:write|say|try)|try\s+(?:to\s+)?(?:write|saying|writing)|try|suggestion|example|coba\s+tulis(?:kan)?|contoh)\s*[:\-–]?\s*)/i;

/**
 * Reduces a model-written suggestion to the bare English sentence: strips an
 * instruction prefix ("Try to write:", "You could write:", "Coba tulis") and
 * surrounding quotes. The student-facing Indonesian wrapper ("Coba tulis
 * \"...\"") is added by the Flutter client, never by the model.
 */
export function extractSuggestedSentence(raw: string): string {
  let text = raw.trim().replace(SUGGESTION_PREFIX_REGEX, '').trim();
  const quoted = text.match(/^["“'‘](.*)["”'’]$/s);
  if (quoted && quoted[1] !== undefined) text = quoted[1].trim();
  return text;
}
