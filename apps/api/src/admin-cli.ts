// Admin accounts from the command line (FN-90, PRD §27.5; Audit 06, A-06-011).
//
// Before this there was no way to create the first admin except raw SQL,
// which §27.5 forbids ("no direct database editing").
//
//   npm run admin -- create --email ops@flyleaf.app [--role admin|moderator] [--username ops]
//   npm run admin -- disable --email ops@flyleaf.app
//
// The password comes from ADMIN_PASSWORD, else a hidden prompt (asked twice),
// else the first line of stdin when it is not a terminal. It is never an
// argument, so it stays out of shell history and the process list.
//
// `create` prints the TOTP secret, its otpauth:// URI and the backup codes
// ONCE, to this terminal only (stdout, never the application logger). Enrol
// them in an authenticator and store the codes offline; they cannot be shown
// again. The same email and password rules as app accounts apply.
//
// A staff account is console-only: the app refuses to log it in (D-06-2).
// Staff read and review in the app with a separate personal account, under a
// different email.

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config, makeDb, closeDb } from './platform/index.js';
import { createAdminUser, disableAdmin, type AdminRole } from './admin/auth.js';
import { getOtpAuthUri } from './admin/totp.js';

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** A prompt that does not echo what is typed. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const mutable = rl as unknown as { _writeToOutput: (s: string) => void };
    mutable._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (process.stdin.isTTY) {
    const first = await askHidden('Password: ');
    const second = await askHidden('Repeat password: ');
    if (first !== second) throw new Error('The passwords do not match.');
    return first;
  }
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  throw new Error('No password on stdin.');
}

async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  const email = flag(argv, '--email');
  if (!email || (command !== 'create' && command !== 'disable')) {
    console.error('usage: admin create --email <email> [--role admin|moderator] [--username <name>]');
    console.error('       admin disable --email <email>');
    process.exitCode = 2;
    return;
  }

  const db = makeDb(config.databaseUrl, { max: 1 });
  try {
    if (command === 'disable') {
      const gone = await disableAdmin(db, email);
      console.log(`${gone.email} is no longer ${gone.role}; every console session they had has ended.`);
      return;
    }

    const role = (flag(argv, '--role') ?? 'admin') as AdminRole;
    if (role !== 'admin' && role !== 'moderator') throw new Error('--role must be admin or moderator');
    const password = await readPassword();
    const created = await createAdminUser(db, { email, password, role, username: flag(argv, '--username') });

    console.log(`Created ${created.user.role} ${created.user.email}.`);
    console.log('');
    console.log('Enrol this in an authenticator app now; it is not stored anywhere you can read it back:');
    console.log(`  secret:  ${created.secret}`);
    console.log(`  uri:     ${getOtpAuthUri({ email: created.user.email, secret: created.secret })}`);
    console.log('');
    console.log('Backup codes, each usable once. Keep them offline:');
    for (const code of created.backupCodes) console.log(`  ${code}`);
  } finally {
    await closeDb(db);
  }
}

const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { main };
