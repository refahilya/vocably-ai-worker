import { describe, expect, it } from 'vitest';

import {
  containsIndonesianWords,
  containsTargetWordInText,
  extractSuggestedSentence,
  isBareOrFragmentTurn,
  isEchoOfStudentTurn,
  shouldRejectStudentTurnLocally,
  validFormsForSingleWord,
  validateBotTargetWords,
  validateStudentTargetWords,
} from '../src/cowriteValidator';

// Same cases as the Flutter repo's test/utils/cowrite_validator_test.dart —
// the two validators must stay semantically identical.

describe('containsTargetWordInText', () => {
  it('matches base forms and regular/irregular inflections', () => {
    expect(containsTargetWordInText('I pressed the button.', 'button')).toBe(true);
    expect(containsTargetWordInText('I ran to the store.', 'run')).toBe(true);
    expect(containsTargetWordInText('They carried the heavy bags.', 'carry')).toBe(true);
    expect(containsTargetWordInText("The baby's toy fell.", 'baby')).toBe(true);
  });

  it('rejects substring false positives', () => {
    expect(containsTargetWordInText('The attacker ran away.', 'attack')).toBe(false);
    expect(containsTargetWordInText('They launched a counterattack.', 'attack')).toBe(false);
    expect(containsTargetWordInText('That apple is crunchy.', 'run')).toBe(false);
    expect(containsTargetWordInText('She is a fast runner.', 'run')).toBe(false);
  });

  it('accepts said -> say and bit/bitten -> bite', () => {
    expect(containsTargetWordInText('He said hello.', 'say')).toBe(true);
    expect(containsTargetWordInText('The dog bit me.', 'bite')).toBe(true);
    expect(containsTargetWordInText('I was bitten by a mosquito.', 'bite')).toBe(true);
  });

  it('does not accept "lay" as a form of "lie"', () => {
    expect(containsTargetWordInText('I lay the book down.', 'lie')).toBe(false);
    expect(containsTargetWordInText('She is lying on the bed.', 'lie')).toBe(true);
    expect(containsTargetWordInText('Hens lay eggs.', 'lay')).toBe(true);
  });

  it('accepts comparatives/superlatives only in a comparative context', () => {
    expect(containsTargetWordInText('She is taller now.', 'tall')).toBe(true);
    expect(containsTargetWordInText('He is taller than me.', 'tall')).toBe(true);
    expect(containsTargetWordInText("She's a bit taller.", 'tall')).toBe(true);
    expect(containsTargetWordInText('He is the tallest boy.', 'tall')).toBe(true);
    expect(containsTargetWordInText('My dog is bigger than yours.', 'big')).toBe(true);
    expect(containsTargetWordInText('Today is happier than yesterday.', 'happy')).toBe(true);
    expect(containsTargetWordInText('This is better than before.', 'good')).toBe(true);
    expect(containsTargetWordInText('He is a teacher.', 'teach')).toBe(false);
    expect(containsTargetWordInText('The workers went home.', 'work')).toBe(false);
  });
});

describe('isBareOrFragmentTurn / shouldRejectStudentTurnLocally', () => {
  it('treats "Birds fly." as a sentence even when both words are targets', () => {
    expect(isBareOrFragmentTurn('Birds fly.', ['bird', 'fly'])).toBe(false);
    expect(isBareOrFragmentTurn('Dogs and cats run.', ['dog', 'cat', 'run'])).toBe(false);
  });

  it('treats "This works." as a sentence when "this" is a target', () => {
    expect(isBareOrFragmentTurn('This works.', ['this'])).toBe(false);
    expect(isBareOrFragmentTurn('this button', ['this', 'button'])).toBe(true);
  });

  it('never rejects ordinary replies with no target word', () => {
    for (const reply of ['Okay.', 'Yes!', 'The end.']) {
      expect(shouldRejectStudentTurnLocally(reply, ['attack', 'button'])).toBe(false);
    }
    expect(isBareOrFragmentTurn('Okay.', ['attack'])).toBe(true);
  });

  it('rejects bare target words, lists, and fragments', () => {
    const targets = ['attack', 'button', 'ability', 'completely'];
    for (const input of [
      'attack',
      'button?',
      'button button',
      'the button',
      'on the button',
      'attack button completely',
      'attack, button, ability',
      'attacks, buttons',
      'the attack and the button',
    ]) {
      expect(shouldRejectStudentTurnLocally(input, targets)).toBe(true);
    }
  });

  it('accepts valid target-word sentences', () => {
    const targets = ['attack', 'button', 'ability'];
    expect(isBareOrFragmentTurn('I can attack the problem from another angle.', targets)).toBe(false);
    expect(isBareOrFragmentTurn('The button is broken.', targets)).toBe(false);
  });
});

describe('validateStudentTargetWords / validateBotTargetWords', () => {
  it('credits only claimed, eligible words present in a valid sentence', () => {
    expect(
      validateStudentTargetWords(['button', 'attack'], 'I pressed the button carefully.', [
        'attack',
        'button',
      ]),
    ).toEqual(['button']);
    expect(validateStudentTargetWords(['button'], 'the button', ['button'])).toEqual([]);
  });

  it('detects bot usage from the actual text, not the claimed list', () => {
    expect(validateBotTargetWords([], 'I also bought a souvenir there.', ['souvenir'])).toEqual([
      'souvenir',
    ]);
    expect(validateBotTargetWords(['souvenir'], 'They walked to the park.', ['souvenir'])).toEqual([]);
  });
});

// CW-05 — same cases as the Dart group "CW-05: reliable target-word crediting".
describe('CW-05: reliable target-word crediting', () => {
  const credit = (claimed: string[], text: string, eligible: string[] = ['attack']) =>
    validateStudentTargetWords(claimed, text, eligible);

  it('grammar, tense, and agreement errors do not block credit the model reports', () => {
    for (const text of [
      'Yesterday the monster attack the village.',
      'one day a monster came and attack the village',
      'The monsters attacks the village.',
      'He attack me yesterday.',
    ]) {
      expect(credit(['attack'], text)).toEqual(['attack']);
    }
  });

  it('meaningful uses of attack / attacked / attacks / attacking are credited', () => {
    for (const text of [
      'The dragon will attack the castle.',
      'The dragon attacked the castle.',
      'The dragon attacks the castle every night.',
      'The dragon is attacking the castle.',
    ]) {
      expect(credit(['attack'], text)).toEqual(['attack']);
    }
  });

  it('maps a model-reported surface form or formatted string to the remaining base target', () => {
    expect(credit(['attacked'], 'The dragon attacked the castle.')).toEqual(['attack']);
    expect(credit(['attacks'], 'The dragon attacks the castle.')).toEqual(['attack']);
    expect(credit(['attacking'], 'The dragon is attacking the castle.')).toEqual(['attack']);
    expect(credit(['Attack.'], 'The dragon will attack the castle.')).toEqual(['attack']);
    expect(credit(["'attack'"], 'The dragon will attack the castle.')).toEqual(['attack']);
    expect(credit(['"ATTACKS"'], 'The dragon attacks the castle.')).toEqual(['attack']);
    expect(credit(['attacked'], 'The dragon attacks the castle.')).toEqual(['attack']);
  });

  it('maps other supported inflections to their base targets', () => {
    expect(credit(['carried'], 'She carried the heavy box.', ['carry'])).toEqual(['carry']);
    expect(credit(['ran'], 'I ran to school.', ['run'])).toEqual(['run']);
    expect(credit(['babies'], 'The babies are sleeping.', ['baby'])).toEqual(['baby']);
    expect(credit(['stopped'], 'The bus stopped suddenly.', ['stop'])).toEqual(['stop']);
    expect(credit(['taller'], 'She is taller than her brother.', ['tall'])).toEqual(['tall']);
    expect(credit(['said'], 'He said goodbye to us.', ['say'])).toEqual(['say']);
  });

  it('no credit when absent from the text, not remaining, a substring, or a fragment/list', () => {
    expect(credit(['attack'], 'The dragon flew over the castle.')).toEqual([]);
    expect(credit(['attacked'], 'The dragon flew over the castle.')).toEqual([]);
    expect(credit(['button'], 'I pressed the button.', ['attack'])).toEqual([]);
    expect(credit(['attack'], 'They attacked again.', ['village'])).toEqual([]);
    expect(credit(['attack'], 'The attacker ran away.')).toEqual([]);
    expect(credit(['attacker'], 'The attacker ran away.')).toEqual([]);
    expect(credit(['counterattack'], 'They launched a counterattack.')).toEqual([]);
    for (const text of ['attack', 'attacked', 'Attack!', 'the attack', 'attack, button, ability', 'attack button ability']) {
      expect(credit(['attack'], text, ['attack', 'button', 'ability'])).toEqual([]);
    }
  });

  it('rejects invalid over-inflections and generated regular pasts of irregular words', () => {
    for (const bad of ['attackked', 'attackking', 'attackes', 'attackd']) {
      expect(containsTargetWordInText(bad, 'attack')).toBe(false);
      expect(credit([bad], `The dragon ${bad} the castle.`)).toEqual([]);
    }
    expect(validFormsForSingleWord('be').has('bed')).toBe(false);
    expect(validFormsForSingleWord('see').has('seed')).toBe(false);
    expect(validFormsForSingleWord('run').has('runned')).toBe(false);
  });

  it('keeps valid spelling-rule inflections', () => {
    const has = (base: string, forms: string[]) =>
      forms.forEach((f) => expect(validFormsForSingleWord(base).has(f)).toBe(true));
    has('attack', ['attacks', 'attacked', 'attacking']);
    has('stop', ['stops', 'stopped', 'stopping']);
    has('quit', ['quitting']);
    has('decide', ['decides', 'decided', 'deciding']);
    has('agree', ['agreed', 'agreeing']);
    has('die', ['died', 'dying']);
    has('carry', ['carries', 'carried', 'carrying']);
    has('box', ['boxes']);
    has('watch', ['watches']);
    has('potato', ['potatoes']);
    has('knife', ['knives']);
    has('panic', ['panicked', 'panicking']);
    has('play', ['plays', 'played', 'playing']);
  });
});

// Same cases as the Dart group "containsIndonesianWords (deterministic language check)".
describe('containsIndonesianWords (parity with Dart)', () => {
  it('flags Indonesian and mixed Indonesian-English text', () => {
    for (const text of [
      'aku attack temanku',
      'lalu aku tertawa hahaha',
      'gpt, bantu aku membuat list packing barang yang dibutuhkan untuk camping',
      'Saya pergi ke pasar.',
      'The monster attack desa itu.',
      'ini dan itu',
    ]) {
      expect(containsIndonesianWords(text, ['attack'])).toBe(true);
    }
  });

  it('normalizes capitalization and punctuation', () => {
    expect(containsIndonesianWords('AKU attack temanku!!', ['attack'])).toBe(true);
    expect(containsIndonesianWords('"Lalu," kata dia.', [])).toBe(true);
    expect(containsIndonesianWords('Tolong... bantu aku?', [])).toBe(true);
  });

  it('does not flag ordinary English, including off-topic English', () => {
    for (const text of [
      'The monster attacked the village.',
      'Yesterday the monster attack the village.',
      'how many sorting algorithms are there',
      'what is 22+300*7/2',
      'Okay.',
      'The data on the main screen was wrong.',
      'We had jam and bread for breakfast.',
      'She put the pan in the bank of snow.',
      'Ya know, it was a long day.',
    ]) {
      expect(containsIndonesianWords(text, ['attack'])).toBe(false);
    }
  });

  it('weak markers need a second marker; mid-sentence names and yin-yang are ignored', () => {
    expect(containsIndonesianWords('Dan went home early.', [])).toBe(false);
    expect(containsIndonesianWords('I met Dan and Ada at school.', [])).toBe(false);
    expect(containsIndonesianWords('My friend Dia is kind.', [])).toBe(false);
    expect(containsIndonesianWords('dan dia pulang', [])).toBe(true);
    expect(containsIndonesianWords('The yin and yang symbol was on the door.', [])).toBe(false);
    expect(containsIndonesianWords('buku yang merah', [])).toBe(true);
  });

  it('never counts a target vocabulary word as a marker', () => {
    expect(containsIndonesianWords('I bought dari yesterday.', ['dari'])).toBe(false);
    expect(containsIndonesianWords('I bought dari yesterday.', [])).toBe(true);
  });
});

describe('isEchoOfStudentTurn', () => {
  it('flags a repeat or close paraphrase of the student sentence', () => {
    expect(isEchoOfStudentTurn('The monster attacked the village.', 'The monster attacked the village.')).toBe(true);
    expect(isEchoOfStudentTurn('So the monster attacked the village!', 'A monster attacked the village.')).toBe(true);
  });

  it('accepts a continuation that adds a new development', () => {
    expect(
      isEchoOfStudentTurn(
        'The villagers grabbed torches and chased the monster into the forest.',
        'The monster attacked the village.',
      ),
    ).toBe(false);
  });
});

describe('extractSuggestedSentence', () => {
  it('strips English/Indonesian instruction prefixes and quotes', () => {
    expect(extractSuggestedSentence('Try to write: "I order a cup of coffee."')).toBe(
      'I order a cup of coffee.',
    );
    expect(extractSuggestedSentence('You could write: "I bought a souvenir."')).toBe(
      'I bought a souvenir.',
    );
    expect(extractSuggestedSentence('Coba tulis "I order a cup of coffee."')).toBe(
      'I order a cup of coffee.',
    );
    expect(extractSuggestedSentence('I order a cup of coffee.')).toBe('I order a cup of coffee.');
  });
});
