#!/usr/bin/env node

const anydo = require('anydo')
const parseBody = require('anydo/lib/parse-body')
const meow = require('meow')
const config = new (require('conf'))()
const updateNotifier = require('update-notifier')
const https = require('https')
const querystring = require('querystring')
const crypto = require('crypto')
const pkg = require('./package.json')

updateNotifier({ pkg }).notify()

const cli = meow(`
  - Login with email/password
    $ anydo login
      --email you@example.org  (required!)
      --password super-secret  (required!)

  - Login with Google
    $ anydo login-google
      Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.
      See README for setup instructions.

  - Login with Microsoft (Office 365 / VT account)
    $ anydo login-microsoft
      No setup required.

  - Add a task
    $ anydo add "Task description"
      --list "List name"  (optional, defaults to Personal)

  - List your tasks
    $ anydo [tasks]
      --done     include done tasks
      --deleted  include deleted tasks
      --undated  include tasks without due date
      --checked  include checked tasks

  - Logout
    $ anydo logout

`, {
  alias: {
    h: 'help',
    v: 'version',
    e: 'email',
    p: 'password'
  }
})

const flags = cli.flags

const fail = message => {
  console.error('Error: ' + message)
  process.exit(1)
}

const postForm = (hostname, path, body) => new Promise((resolve, reject) => {
  const bodyStr = querystring.stringify(body)
  const req = https.request({
    hostname,
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(bodyStr)
    }
  }, res => {
    let data = ''
    res.on('data', chunk => { data += chunk })
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(data) }) } catch (e) { resolve({ status: res.statusCode, body: data }) }
    })
    res.on('error', reject)
  })
  req.on('error', reject)
  req.write(bodyStr)
  req.end()
})

const postJSON = (hostname, path, body, extraHeaders) => new Promise((resolve, reject) => {
  const bodyStr = JSON.stringify(body)
  const req = https.request({
    hostname,
    path,
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr)
    }, extraHeaders || {})
  }, res => {
    let data = ''
    res.on('data', chunk => { data += chunk })
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }) } catch (e) { resolve({ status: res.statusCode, body: data, headers: res.headers }) }
    })
    res.on('error', reject)
  })
  req.on('error', reject)
  req.write(bodyStr)
  req.end()
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const login = () => {
  if (!flags.email) return fail('Please specify an email via the `--email` flag')
  if (!flags.password) return fail('Please specify a password via the `--password` flag')
  anydo.login(flags, (err, res) => {
    if (err) return fail(err.message)
    config.set('anydo.auth', res.headers['x-anydo-auth'])
  })
}

const loginGoogle = async () => {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!clientId) return fail('GOOGLE_CLIENT_ID environment variable is required (see README)')
  if (!clientSecret) return fail('GOOGLE_CLIENT_SECRET environment variable is required (see README)')

  // Step 1: Request a device code from Google
  const deviceRes = await postForm('oauth2.googleapis.com', '/device/code', {
    client_id: clientId,
    scope: 'openid email profile'
  })

  if (deviceRes.status !== 200) {
    return fail('Failed to start Google OAuth: ' + JSON.stringify(deviceRes.body))
  }

  const { device_code, user_code, verification_url, expires_in, interval } = deviceRes.body

  console.log('\nTo login with Google:')
  console.log('  1. Open: ' + verification_url)
  console.log('  2. Enter code: ' + user_code)
  console.log('\nWaiting for authorization...')

  // Step 2: Poll Google until the user approves
  let pollInterval = (interval || 5) * 1000
  const deadline = Date.now() + expires_in * 1000

  while (Date.now() < deadline) {
    await sleep(pollInterval)

    const tokenRes = await postForm('oauth2.googleapis.com', '/token', {
      client_id: clientId,
      client_secret: clientSecret,
      device_code,
      grant_type: 'urn:ietf:params:oauth2:grant-type:device_code'
    })

    const { error, id_token } = tokenRes.body

    if (error === 'authorization_pending') continue
    if (error === 'slow_down') { pollInterval += 5000; continue }
    if (error === 'access_denied') return fail('Authorization denied')
    if (error === 'expired_token') return fail('Device code expired — please try again')
    if (error) return fail('Google OAuth error: ' + error)
    if (!id_token) return fail('No ID token received from Google')

    // Step 3: Exchange the Google ID token with Any.do
    const anydoRes = await postJSON('sm-prod4.any.do', '/google-login', {
      id_token,
      platform: 'web',
      referrer: null,
      create_predefined_data: { lists: true, label: true }
    }, { 'X-Platform': '3' })

    const authToken = (anydoRes.body && anydoRes.body.auth_token) || anydoRes.headers['x-anydo-auth']

    if (!authToken) {
      return fail('Any.do login failed (status ' + anydoRes.status + '): ' + JSON.stringify(anydoRes.body))
    }

    config.set('anydo.auth', authToken)
    console.log('Logged in successfully!')
    return
  }

  fail('Device code expired — please try again')
}

// Any.do's own Azure AD app ID — no user setup required
const ANYDO_AZURE_CLIENT_ID = 'bf12a03f-3d2b-42f6-ac11-9aee2c0ad5bc'
const MS_TENANT = 'common'

const loginMicrosoft = async () => {
  // Step 1: Request a device code from Microsoft using Any.do's own Azure app
  const deviceRes = await postForm(
    'login.microsoftonline.com',
    '/' + MS_TENANT + '/oauth2/v2.0/devicecode',
    {
      client_id: ANYDO_AZURE_CLIENT_ID,
      scope: 'openid email profile User.Read'
    }
  )

  if (deviceRes.status !== 200) {
    return fail('Failed to start Microsoft OAuth: ' + JSON.stringify(deviceRes.body))
  }

  const { device_code, user_code, verification_uri, expires_in, interval } = deviceRes.body

  console.log('\nTo login with Microsoft:')
  console.log('  1. Open: ' + verification_uri)
  console.log('  2. Enter code: ' + user_code)
  console.log('\nWaiting for authorization...')

  // Step 2: Poll Microsoft until the user approves
  let pollInterval = (interval || 5) * 1000
  const deadline = Date.now() + expires_in * 1000

  while (Date.now() < deadline) {
    await sleep(pollInterval)

    const tokenRes = await postForm(
      'login.microsoftonline.com',
      '/' + MS_TENANT + '/oauth2/v2.0/token',
      {
        client_id: ANYDO_AZURE_CLIENT_ID,
        device_code,
        grant_type: 'urn:ietf:params:oauth2:grant-type:device_code'
      }
    )

    const { error, id_token, access_token } = tokenRes.body

    if (error === 'authorization_pending') continue
    if (error === 'slow_down') { pollInterval += 5000; continue }
    if (error === 'access_denied') return fail('Authorization denied')
    if (error === 'expired_token') return fail('Device code expired — please try again')
    if (error) return fail('Microsoft OAuth error: ' + error)
    if (!id_token) return fail('No ID token received from Microsoft')

    // Step 3: Exchange the Microsoft token with Any.do
    // Try /microsoft-login first; the endpoint mirrors /google-login by convention
    const anydoRes = await postJSON('sm-prod4.any.do', '/microsoft-login', {
      id_token,
      access_token,
      platform: 'web',
      referrer: null,
      create_predefined_data: { lists: true, label: true }
    }, { 'X-Platform': '3' })

    const authToken = (anydoRes.body && anydoRes.body.auth_token) || anydoRes.headers['x-anydo-auth']

    if (!authToken) {
      return fail(
        'Any.do login failed (status ' + anydoRes.status + '): ' + JSON.stringify(anydoRes.body) +
        '\nIf this is a 404, the endpoint name may differ — capture the network request from app.any.do and share it.'
      )
    }

    config.set('anydo.auth', authToken)
    console.log('Logged in successfully!')
    return
  }

  fail('Device code expired — please try again')
}

const syncData = (auth) => new Promise((resolve, reject) => {
  anydo.sync({ auth, includeDone: false, includeDeleted: false }, (err, res) => {
    if (err) return reject(err)
    parseBody(res, (err, body) => err ? reject(err) : resolve(body))
  })
})

const addTask = async () => {
  const title = cli.input[1]
  if (!title) return fail('Please provide a task description: anydo add "Task description"')

  const auth = config.get('anydo.auth')
  if (!auth) return fail('Please login first via the `login` or `login-microsoft` command')

  // Extract email from auth token (format: base64(email:timestamp:hash))
  const email = Buffer.from(auth, 'base64').toString().split(':')[0]

  const body = await syncData(auth)
  const categories = body.models.category.items.filter(c => !c.isDeleted)

  let category
  if (flags.list) {
    category = categories.find(c => c.name.toLowerCase() === flags.list.toLowerCase())
    if (!category) {
      const names = categories.map(c => c.name).join(', ')
      return fail('List "' + flags.list + '" not found. Available: ' + names)
    }
  } else {
    category = categories.find(c => c.name.toLowerCase() === 'personal') || categories[0]
  }

  const id = crypto.randomBytes(18).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const now = Date.now()

  const task = {
    id,
    globalTaskId: id,
    title,
    note: '',
    priority: 'Normal',
    status: 'UNCHECKED',
    categoryId: category.id,
    dueDate: null,
    creationDate: now,
    assignedTo: email,
    shared: false,
    participants: [],
    subTasks: [],
    repeatingMethod: 'TASK_REPEAT_OFF',
    longitude: null,
    latitude: null
  }

  const res = await postJSON('sm-prod4.any.do', '/api/v2/me/sync?updatedSince=0', {
    models: {
      task: { items: [task] },
      category: { items: [] },
      attachment: { items: [] },
      sharedMember: { items: [] },
      userNotification: { items: [] },
      taskNotification: { items: [] }
    }
  }, { 'X-Anydo-Auth': auth, 'X-Anydo-Platform': 'web', 'X-Platform': '3' })

  if (res.status !== 200 && res.status !== 201) {
    return fail('Failed to create task (status ' + res.status + '): ' + JSON.stringify(res.body))
  }

  console.log('Added "' + title + '" to ' + category.name)
}

const logout = () => {
  config.delete('anydo.auth')
}

const tasks = () => {
  const auth = config.get('anydo.auth')
  if (!auth) return fail('Please login first via the `login`, `login-google`, or `login-microsoft` command')
  anydo.sync({
    auth,
    includeDone: flags.done || false,
    includeDeleted: flags.deleted || false
  }, (err, res) => {
    if (err) return fail(err.message)
    parseBody(res, (err, body) => {
      if (err) return fail(err.message)
      body.models.task.items
        .filter(t => flags.undated ? true : t.dueDate)
        .filter(t => flags.checked ? true : t.status !== 'CHECKED')
        .map(t => '- ' + t.title)
        .forEach(t => console.log(t))
    })
  })
}

switch (cli.input[0]) {
  case 'login': login(); break
  case 'login-google': loginGoogle().catch(err => fail(err.message)); break
  case 'login-microsoft': loginMicrosoft().catch(err => fail(err.message)); break
  case 'add': addTask().catch(err => fail(err.message)); break
  case 'logout': logout(); break
  case 'tasks': tasks(); break
  default: tasks(); break
}
