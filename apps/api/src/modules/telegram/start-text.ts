// Matches "/start", "/start@bot", "/start payload". Used before grammY's command matching has
// run (the user-context middleware needs the referral code to create the user).
const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/;

export function startPayloadText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return START_COMMAND.exec(text)?.[1];
}
