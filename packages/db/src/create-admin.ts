import bcrypt from 'bcryptjs';
import { prisma, AdminRole } from './index.js';

const usernamePattern = /^[a-zA-Z0-9._-]{3,64}$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const username = process.env.ADMIN_USERNAME ?? '';
if (!usernamePattern.test(username)) fail('ADMIN_USERNAME must match /^[a-zA-Z0-9._-]{3,64}$/');

const role = process.env.ADMIN_ROLE ?? AdminRole.ADMIN;
if (!Object.values(AdminRole).includes(role as AdminRole)) {
  fail(`ADMIN_ROLE must be one of ${Object.values(AdminRole).join(', ')}`);
}

const password = (process.env.ADMIN_PASSWORD ?? (await readPasswordFromStdin())).trim();
if (password.length < 12) fail('password must be at least 12 characters');

const passwordHash = await bcrypt.hash(password, 12);
const admin = await prisma.adminUser.upsert({
  where: { username },
  update: { passwordHash, role: role as AdminRole },
  create: { username, passwordHash, role: role as AdminRole },
});
console.log(`admin ${admin.username} (${admin.role}) ready`);
await prisma.$disconnect();
