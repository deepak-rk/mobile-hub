import * as argon2 from 'argon2';
import type { AuthUserStore } from 'fastify-auth-kit';
import { User, IUser, UserRole } from './user.model';

interface MongoDuplicateKeyError {
  code: number;
}

function isDuplicateKeyError(err: unknown): err is MongoDuplicateKeyError {
  return typeof err === 'object' && err !== null && 'code' in err && (err as MongoDuplicateKeyError).code === 11000;
}

/**
 * mobile-hub's implementation of fastify-auth-kit's AuthUserStore: owns the
 * Mongoose model, argon2 hashing, and the first-user-is-admin policy - none
 * of which the package itself has an opinion on.
 */
export function createUserStore(): AuthUserStore<IUser, UserRole> {
  return {
    async createUser({ email, name, password }) {
      const { DuplicateUserError } = await import('fastify-auth-kit');
      const isFirstUser = (await User.estimatedDocumentCount()) === 0;
      const passwordHash = await argon2.hash(password);
      try {
        return await User.create({
          email,
          name,
          passwordHash,
          role: isFirstUser ? 'admin' : 'viewer',
        });
      } catch (err) {
        if (isDuplicateKeyError(err)) throw new DuplicateUserError('Email already registered');
        throw err;
      }
    },

    async verifyCredentials(email, password) {
      const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+passwordHash');
      if (!user) return null;
      const valid = await argon2.verify(user.passwordHash, password);
      if (!valid) return null;
      return user;
    },

    async getUserById(id) {
      return User.findById(id);
    },

    toJwtPayload(user) {
      return { sub: user._id.toString(), role: user.role };
    },

    toPublicUser(user) {
      return { id: user._id.toString(), email: user.email, name: user.name, role: user.role };
    },
  };
}
