// 可选访问口令门禁（P0-12）：仅当环境变量 ACCESS_PIN 已设置时启用。
// 未设置 ACCESS_PIN → 一律放行（默认本地单机使用，零门槛）。
// 通过方式：浏览器访问一次 `http://<地址>:3000/?pin=<ACCESS_PIN>`，随后种下 httpOnly Cookie。
// 说明：middleware 自身任何异常都会放行，绝不因门禁逻辑把整站弄成不可用。
import { NextResponse, type NextRequest } from 'next/server';

const PIN_COOKIE = 'gf_pin';

/** pin 的 sha256 十六进制（Cookie 里不存明文 pin），Web Crypto 在 edge 运行时可用 */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function unauthorizedPage(): string {
  return [
    '🔒 需要访问口令',
    '',
    '本应用已启用访问保护（环境变量 ACCESS_PIN）。',
    '',
    '请在浏览器地址栏访问一次：',
    '    http://<本机地址>:3000/?pin=<你设置的 ACCESS_PIN>',
    '',
    '通过后浏览器会记住（httpOnly Cookie），之后正常使用即可。',
    '',
  ].join('\n');
}

export async function middleware(req: NextRequest) {
  try {
    const pin = process.env.ACCESS_PIN;
    if (!pin) return NextResponse.next(); // 未设置 → 一律放行

    const expected = await sha256Hex(pin);
    const url = req.nextUrl;

    // 带正确口令 → 种 Cookie 后跳回"去掉 pin 的地址"
    const queryPin = url.searchParams.get('pin');
    if (queryPin !== null && queryPin === pin) {
      const clean = url.clone();
      clean.searchParams.delete('pin');
      const res = NextResponse.redirect(clean);
      res.cookies.set(PIN_COOKIE, expected, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
        secure: url.protocol === 'https:',
      });
      return res;
    }

    // 已通过（Cookie 值等于 pin 的 sha256）
    if (req.cookies.get(PIN_COOKIE)?.value === expected) return NextResponse.next();

    return new NextResponse(unauthorizedPage(), {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'PIN' },
    });
  } catch {
    return NextResponse.next(); // 门禁出错时放行，保证应用仍可用
  }
}

// 放行 Next 静态资源与带扩展名的静态文件（/_next、favicon、/sw.js、图标等）
export const config = {
  matcher: ['/((?!_next/|favicon.ico|.*\\..*).*)'],
};