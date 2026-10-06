import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { verifyPassword, isSessionRevoked, changePassword } from "@/lib/password";
export { changePassword };

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 7 * 86400 },
  providers: [
    Credentials({
      name: "Email",
      credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
      async authorize(creds) {
        const email = String(creds?.email ?? "").toLowerCase().trim();
        const password = String(creds?.password ?? "");
        if (!email || !password) return null;
        const user = await db.user.findUnique({ where: { email } }).catch(() => null);
        if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) return null;
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        token.userId = user.id;
        // Stamp the session with the current version so later password
        // changes / disables invalidate outstanding tokens.
        const row = await db.user.findUnique({ where: { id: user.id }, select: { sessionVersion: true } }).catch(() => null);
        token.sv = row?.sessionVersion ?? 0;
      } else if (token.userId) {
        // Refresh path (runs on session access): reject revoked sessions.
        const row = await db.user.findUnique({ where: { id: token.userId as string }, select: { sessionVersion: true } }).catch(() => null);
        if (isSessionRevoked(token.sv as number | undefined, row?.sessionVersion)) {
          return { ...token, error: "revoked" } as typeof token;
        }
        if (token.sv === undefined && row) {
          // Legacy token issued before versioning existed: adopt the current
          // version once instead of logging every existing user out on deploy.
          token.sv = row.sessionVersion;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if ((token as unknown as { error?: string }).error === "revoked") return null as unknown as typeof session;
      (session as unknown as { userId?: string }).userId = (token.userId ?? token.sub) as string | undefined;
      return session;
    },
  },
});
