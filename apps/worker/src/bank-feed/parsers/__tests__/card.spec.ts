import { parseBankMessage } from '../parse-bank-message';
import { humoMessage, loadFixture, uzcardMessage } from './synthetic';

const CARD = '\u{1F4B3}';
const cardFormat = { ok: false, reason: 'CARD_FORMAT' };

// Review finding S5 #5: the card shape belongs to the bank; neither accepts the other's.
describe('card line shape per bank', () => {
  it.each([
    ['HUMOCARD *0000', '0000'],
    ['*0000', '0000'],
  ])('Humo accepts %s', (card, last4) => {
    expect(parseBankMessage('HUMO_BOT', humoMessage({ card: `${CARD} ${card}` }))).toEqual(
      expect.objectContaining({ ok: true, last4 }),
    );
  });

  it.each([
    ['the Uzcard shape', '***1111'],
    ['two stars', '**1111'],
    ['brand word with three stars', 'HUMOCARD ***1111'],
    ['no star', 'HUMOCARD 0000'],
    ['four stars', '****1111'],
    ['three digits', '*000'],
    ['five digits', '*00000'],
    ['other brand word', 'UZCARD *0000'],
    ['lower-case brand word', 'humocard *0000'],
    ['full number shape', '0000 0000 0000 0000'],
  ])('Humo refuses %s', (_, card) => {
    expect(parseBankMessage('HUMO_BOT', humoMessage({ card: `${CARD} ${card}` }))).toEqual(
      cardFormat,
    );
  });

  it.each([
    ['***1111', '1111'],
    ['***9999', '9999'],
  ])('Uzcard accepts %s', (card, last4) => {
    expect(parseBankMessage('UZCARD_BOT', uzcardMessage({ card: `${CARD} ${card}` }))).toEqual(
      expect.objectContaining({ ok: true, last4 }),
    );
  });

  it.each([
    ['the Humo shape', '*0000'],
    ['the Humo shape with brand word', 'HUMOCARD *0000'],
    ['two stars', '**1111'],
    ['four stars', '****1111'],
    ['three digits', '***111'],
    ['five digits', '***11111'],
    ['brand word', 'UZCARD ***1111'],
    ['full number shape', '0000 0000 0000 0000'],
  ])('Uzcard refuses %s', (_, card) => {
    expect(parseBankMessage('UZCARD_BOT', uzcardMessage({ card: `${CARD} ${card}` }))).toEqual(
      cardFormat,
    );
  });

  it("a fixture from one bank's bot is refused by the other bank's parser", () => {
    expect(parseBankMessage('UZCARD_BOT', loadFixture('humo.uz.credit.txt'))).toEqual(cardFormat);
    expect(parseBankMessage('HUMO_BOT', loadFixture('uzcard.ru.credit.txt'))).toEqual(cardFormat);
  });
});
