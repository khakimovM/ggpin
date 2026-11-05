// Dev-only sample copy for the component gallery (never shipped: /dev/ui is a 404 in
// production). Wherever the real catalog already has a key the gallery reads it instead
// (common.retry, common.comingSoon, common.money.uzs).
const uz = {
  buy: 'Sotib olish',
  topUp: 'To‘ldirish',
  change: 'O‘zgartirish',
  cancel: 'Bekor qilish',
  remove: 'O‘chirish',
  more: 'Batafsil',
  pay: 'To‘lash',
  paying: 'To‘lanmoqda…',
  longMoneyButton: '37 050 so‘m to‘ldirib sotib olish',
  confirmRecipient: 'Qabul qiluvchini tasdiqlang',
  inWallet: 'Hamyonda:',
  shortBy: 'Yetishmaydi:',
  topUpWallet: 'Hamyonni to‘ldirish',
  usernameLabel: 'Telegram username',
  usernameHelp: 'Stars shu akkauntga yuboriladi. “@” ni yozish shart emas',
  usernameError: 'Akkaunt topilmadi. Username’ni tekshiring',
  usernameOk: 'Format to‘g‘ri',
  promoLabel: 'Promokod',
  promoHelp: 'Bo‘lsa, kiriting — chegirma darhol qo‘llanadi',
  promoError: 'Promokod topilmadi yoki muddati tugagan',
  promoDisabled: 'Bu mahsulotga qo‘llanmaydi',
  playerId: 'Player ID',
  zoneId: 'Zone ID',
  optional: '· ixt.',
  amountLabel: 'To‘ldirish summasi',
  amountHelp: 'Minimal 1 000 so‘m · komissiyasiz',
  amountMin: 'Minimal 1 000 so‘m',
  amountMax: 'Maksimal 5 000 000 so‘m',
  qtyLabel: 'Stars miqdori',
  qtyHelp: 'Minimal 50 ⭐',
  qtyOutOfRange: '50 dan 1 000 gacha kiriting',
  decrement: 'Kamaytirish',
  increment: 'Ko‘paytirish',
  otpGroup: 'Tasdiqlash kodi',
  otpBox: (n: number) => `Kod, ${n}-raqam`,
  otpWrong: 'Kod noto‘g‘ri. 2 ta urinish qoldi',
  reduceMotion: 'Animatsiyalarni kamaytirish',
  chips: ['Barchasi', 'Yetkazildi', 'Bajarilmoqda', 'Qaytarildi', 'Bekor qilindi'],
  removeFilter: 'Olib tashlash',
  segments: ['Buyurtmalar', 'Moliya'],
  segmentsLabel: 'Bo‘lim',
  tabs: ['Hammasi', 'O‘yinlar', 'Telegram', 'Kartalar'],
  tabsLabel: 'Kategoriyalar',
  langLabel: 'Til',
  popular: 'Mashhur',
  auto: 'Avto',
  promoCode: 'Promokod',
  premium: 'Premium',
  sngRegion: 'SNG',
  ribbon: 'Eng foydali',
  stock: { inStock: 'Mavjud', low: '69 ta qoldi', soldOut: 'Tugagan' },
  status: {
    PAID: ['To‘landi', 'To‘landi'],
    QUEUED: ['Navbatda', 'Navbatda'],
    PROCESSING: ['Bajarilmoqda', 'Bajarilmoqda'],
    NEEDS_REVIEW: ['Tekshirilmoqda', 'Tekshirilmoqda'],
    HELD: ['Tekshirilmoqda', 'Tekshirilmoqda'],
    DELIVERED: ['Yetkazildi', 'Yetkazildi'],
    FAILED: ['Bajarilmadi · qaytarildi', 'Bajarilmadi'],
    REFUNDED: ['Bajarilmadi · qaytarildi', 'Bajarilmadi'],
    CANCELLED: ['Bekor qilindi', 'Bekor qilindi'],
  },
  sheetTitle: 'Buyurtmani tasdiqlang',
  sheetStep2: 'Qabul qiluvchi',
  sheetDescription: 'Ma’lumotlarni tekshirib, to‘lang',
  product: 'Mahsulot',
  total: 'Jami',
  remains: 'Hamyonda qoladi',
  autoDelivery: 'Avtomatik yetkaziladi · 1–2 daqiqa',
  next: 'Keyingi qadam',
  close: 'Yopish',
  back: 'Orqaga',
  open: 'Ochish',
  faq: [
    [
      'Buyurtma qancha vaqtda yetkaziladi?',
      'Odatda 1–2 daqiqa. Holatini “Tarix” bo‘limida real vaqtda ko‘rasiz.',
    ],
    [
      'ID ni noto‘g‘ri kiritsam nima bo‘ladi?',
      'To‘lovdan oldin qabul qiluvchi nomini ko‘rsatamiz — tasdiqlamaguningizcha pul yechilmaydi.',
    ],
    ['Buyurtma bajarilmasa-chi?', 'Pul avtomatik ravishda hamyoningizga qaytariladi.'],
  ],
  toasts: {
    success: ['Yetkazildi', '500 ⭐ @dilnoza_k ga yuborildi'],
    error: ['To‘lov o‘tmadi', 'Karta balansini tekshirib, qayta urinib ko‘ring'],
    warning: ['ID ni tekshiring', 'Bu ID bilan o‘yinchi topilmadi'],
    info: ['Hamyon to‘ldirildi', '+150 000 so‘m'],
  },
  timeline: [
    ['Buyurtma qabul qilindi', 'Bugun, 14:02'],
    ['Hamyondan 165 000 so‘m yechildi', 'Bugun, 14:02'],
    ['@jasur_t ga yuborilmoqda', 'Odatda 1–2 daqiqa. Sahifani yopsangiz ham davom etadi'],
    ['Yetkazildi', 'Botdan xabar keladi'],
  ],
  timelineLabel: 'Buyurtma holati',
  timelineStates: { done: 'Bajarildi', active: 'Joriy qadam', pending: 'Kutilmoqda' },
  currentStep: 'Joriy qadam',
  orderLine: '500 ⭐ → @dilnoza_k',
  orderMeta: '#10482 · Bugun, 14:05',
  errorTitle: 'Yuklab bo‘lmadi',
  errorText: 'Internetni tekshiring',
  emptyTitle: 'Hali buyurtma yo‘q',
  emptyText: 'Birinchi xaridingiz shu yerda ko‘rinadi',
  emptyAction: 'Xarid qilish',
  name: 'Sardor Rahimov',
  dateUser: 'Bugun, 14:05',
} as const;

// Literal strings and readonly tuples widened, so the Russian table can use other strings while
// the compiler still checks that no key is missing.
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T extends readonly []
      ? readonly []
      : T extends readonly [infer Head, ...infer Rest]
        ? readonly [Widen<Head>, ...Widen<Rest>]
        : T extends readonly (infer Item)[]
          ? readonly Widen<Item>[]
          : { -readonly [K in keyof T]: Widen<T[K]> };

export type Sample = Widen<typeof uz>;
export const UZ: Sample = uz;
