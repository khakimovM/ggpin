import { renderTemplate, translate, translateLenient, TranslationError } from './translate';

describe('translate', () => {
  it('substitutes and HTML-escapes params', () => {
    const text = translate('uz', 'bot.start.welcome', { name: '<b>&' });
    expect(text).toContain('&lt;b&gt;&amp;');
    expect(text).not.toContain('<b>');
  });

  it('reads both locales', () => {
    expect(translate('ru', 'bot.lang.changed')).toContain('Язык');
    expect(translate('uz', 'bot.lang.changed')).toContain('Til');
  });

  it('throws on a missing key and on a missing param', () => {
    expect(() => translate('uz', 'bot.nope')).toThrow(TranslationError);
    expect(() => translate('uz', 'bot.start.welcome')).toThrow('needs param "name"');
  });

  it('does not treat inherited object keys as params', () => {
    expect(() => translate('uz', 'bot.start.welcome', {})).toThrow(TranslationError);
  });

  it('refuses ICU plural/select templates', () => {
    const icu = '{count, plural, one {# ta} other {# ta}}';
    expect(() => renderTemplate(icu, 'x.y', { count: 1 })).toThrow('ICU');
    expect(() => renderTemplate('{n, select, a {b} other {c}}', 'x.y', { n: 'a' })).toThrow('ICU');
  });

  it('lenient: reports a missing key and falls back to the key text', () => {
    const problems: string[] = [];
    const out = translateLenient('ru', 'bot.nope', {}, (e) => problems.push(e.message));
    expect(out).toBe('bot.nope');
    expect(problems).toHaveLength(1);
  });

  it('lenient: a message that fails in ru falls back to uz', () => {
    const problems: string[] = [];
    // Missing param fails in both locales, so the key is the last resort.
    const out = translateLenient('ru', 'bot.start.welcome', {}, (e) => problems.push(e.message));
    expect(out).toBe('bot.start.welcome');
    expect(problems).toHaveLength(1);
  });
});
