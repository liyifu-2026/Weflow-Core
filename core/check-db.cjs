const { Client } = require("pg");
async function main() {
  const c = new Client({ connectionString: "postgresql://weflow:weflow@127.0.0.1:5432/weflow" });
  await c.connect();
  const r = await c.query('SELECT user_id, username, role, status, must_change_password, password_hash FROM identity.users');
  r.rows.forEach(x => console.log(x.username, "-", x.role, "-", x.status, "- mustChange:", x.must_change_password, "- hash:", x.password_hash?.substring(0, 30)));
  await c.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
