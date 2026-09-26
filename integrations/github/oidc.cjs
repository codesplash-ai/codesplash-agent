const fs = require("node:fs/promises")
async function main() {
  const exchange = new URL(process.env.CS_EXCHANGE_URL)
  if (
    exchange.protocol !== "https:" ||
    exchange.username ||
    exchange.password ||
    exchange.hash ||
    exchange.search
  )
    throw Error("OIDC exchange must use HTTPS")
  const endpoint = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
  endpoint.searchParams.set("audience", process.env.CS_OIDC_AUDIENCE)
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    redirect: "error",
  })
  if (!response.ok) throw Error("GitHub OIDC request failed")
  const { value } = await response.json()
  const result = await fetch(exchange, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: value }),
    redirect: "error",
  })
  if (!result.ok) throw Error("GitHub App exchange failed")
  const credentials = await result.json()
  if (typeof credentials.token !== "string" || !/^[A-Za-z0-9_]+$/.test(credentials.token))
    throw Error("Invalid GitHub App token")
  process.stdout.write(`::add-mask::${credentials.token}\n`)
  await fs.appendFile(process.env.GITHUB_ENV, `GH_TOKEN=${credentials.token}\n`)
}
main().catch(() => {
  process.stderr.write("CodeSplash OIDC exchange failed\n")
  process.exitCode = 1
})
