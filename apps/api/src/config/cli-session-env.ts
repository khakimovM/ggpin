// The owner CLI's facts about its terminal (who runs it, from where), read once at start. Not
// part of the validated API config: they describe the process, and the CLI checks their shape
// (cli/cli-session.ts) before anything lands in the AuditLog.
export interface CliSessionEnv {
  readonly SSH_CONNECTION?: string;
  readonly SSH_CLIENT?: string;
  readonly SUDO_USER?: string;
}

export function cliSessionEnv(source: NodeJS.ProcessEnv = process.env): CliSessionEnv {
  const pick = (name: keyof CliSessionEnv) => {
    const value = source[name];
    return value === undefined ? {} : { [name]: value };
  };
  return { ...pick('SSH_CONNECTION'), ...pick('SSH_CLIENT'), ...pick('SUDO_USER') };
}
