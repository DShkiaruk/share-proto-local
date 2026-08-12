export default function handler(req, res) {
  res.setHeader(
    'Set-Cookie',
    'fp_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  );
  res.writeHead(302, { Location: '/' });
  res.end();
}
