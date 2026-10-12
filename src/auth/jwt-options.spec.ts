import { JwtService } from '@nestjs/jwt';
import { ACCESS_TOKEN_TTL_SECONDS, buildJwtOptions } from './jwt-options';

describe('buildJwtOptions', () => {
  const jwt = new JwtService(buildJwtOptions('test-secret'));

  it('issues tokens that expire in exactly 24 hours', () => {
    const token = jwt.sign({ sub: 'user-1', role: 'ADMIN' });
    const { iat, exp } = jwt.decode<{ iat: number; exp: number }>(token);

    expect(exp - iat).toBe(24 * 60 * 60);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('rejects a token once it has expired', () => {
    const token = jwt.sign({ sub: 'user-1' }, { expiresIn: -1 });
    expect(() => {
      jwt.verify(token);
    }).toThrow('jwt expired');
  });

  it('signs with the secret it was given', () => {
    const token = jwt.sign({ sub: 'user-1' });
    const other = new JwtService(buildJwtOptions('another-secret'));
    expect(() => {
      other.verify(token);
    }).toThrow('invalid signature');
  });
});
