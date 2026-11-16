import { EmailInput, SignInInput, SignUpInput, type CheckInboxResponse } from '@erp/shared'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState } from 'react'
import { Pressable, Switch, Text, View } from 'react-native'
import type { z } from 'zod'
import { api, ApiError } from '../lib/api'
import { useSession } from '../lib/session'
import { Body, Brand, Button, Card, ErrorBox, Field, Screen, Title, useColors } from '../ui/components'

export type SignedOutStack = { SignIn: undefined; SignUp: undefined; Forgot: undefined }
type Props<K extends keyof SignedOutStack> = NativeStackScreenProps<SignedOutStack, K>

type Errors = Record<string, string | undefined>

/** Checks a form with the same rules the API uses; returns the first message per field. */
function check<S extends z.ZodType>(schema: S, values: unknown): { ok: true; data: z.output<S> } | { ok: false; errors: Errors } {
  const r = schema.safeParse(values)
  if (r.success) return { ok: true, data: r.data }
  const errors: Errors = {}
  for (const issue of r.error.issues) {
    const key = String(issue.path[0] ?? 'form')
    errors[key] ??= issue.message
  }
  return { ok: false, errors }
}

/** An API error goes under its field when it names one, otherwise above the form. */
const fromApi = (e: unknown): Errors => (e instanceof ApiError && e.field ? { [e.field]: e.message } : { form: (e as Error).message })

function Link({ text, onPress }: { text: string; onPress: () => void }) {
  const c = useColors()
  return (
    <Pressable accessibilityRole="link" onPress={onPress} hitSlop={8}>
      <Text style={{ color: c.fg, textDecorationLine: 'underline', fontSize: 15, textAlign: 'center' }}>{text}</Text>
    </Pressable>
  )
}

/** For investors and the curious: a ready-made business, no account needed. */
function TryDemo() {
  const { startDemo } = useSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  return (
    <Card>
      <Body>Just looking? Open a ready-made food distributor with stock, payroll and leave already running. It’s yours until 3 a.m.</Body>
      <ErrorBox message={error} />
      <Button
        title={busy ? 'Setting it up… (up to a minute)' : 'Try the demo'}
        variant="outline"
        busy={busy}
        onPress={() => {
          setBusy(true)
          setError(undefined)
          startDemo().catch((e: Error) => {
            setError(e.message)
            setBusy(false)
          })
        }}
      />
    </Card>
  )
}

export function SignInScreen({ navigation }: Props<'SignIn'>) {
  const { signIn } = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)

  async function submit() {
    const r = check(SignInInput, { email, password, remember: true })
    if (!r.ok) return setErrors(r.errors)
    setBusy(true)
    setErrors({})
    try {
      await signIn(r.data.email, r.data.password)
    } catch (e) {
      setErrors(fromApi(e))
      setBusy(false)
    }
  }

  return (
    <Screen>
      <View style={{ marginTop: 24, marginBottom: 12 }}>
        <Brand />
      </View>
      <Title sub="Welcome back. You’ll stay signed in on this phone for 30 days.">Sign in</Title>
      <ErrorBox message={errors.form} />
      <Field label="Email" value={email} onChangeText={setEmail} error={errors.email} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" />
      <Field label="Password" value={password} onChangeText={setPassword} error={errors.password} secureTextEntry autoComplete="current-password" textContentType="password" onSubmitEditing={() => void submit()} />
      <Button title="Sign in" onPress={() => void submit()} busy={busy} />
      <Link text="Forgot your password?" onPress={() => navigation.navigate('Forgot')} />
      <View style={{ height: 8 }} />
      <Link text="New here? Create an account" onPress={() => navigation.navigate('SignUp')} />
      <View style={{ height: 8 }} />
      <TryDemo />
    </Screen>
  )
}

function CheckInbox({ sent, onBack }: { sent: CheckInboxResponse; onBack: () => void }) {
  return (
    <Screen>
      <Title sub={sent.status === 'verify-email' ? `We sent a link to ${sent.email}. Open it to finish signing up, then sign in here.` : `If there’s an account for ${sent.email}, we sent it a link to choose a new password.`}>
        Check your email
      </Title>
      {sent.delivery === 'console' && (
        <Card>
          <Body muted>No mail server is set up, so the link is printed in the API’s terminal instead.</Body>
        </Card>
      )}
      <Button title="Back to sign in" variant="outline" onPress={onBack} />
    </Screen>
  )
}

export function SignUpScreen({ navigation }: Props<'SignUp'>) {
  const c = useColors()
  const [values, setValues] = useState({ name: '', email: '', password: '', acceptedTerms: false })
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<CheckInboxResponse | null>(null)
  const set = (k: keyof typeof values) => (v: string | boolean) => setValues((s) => ({ ...s, [k]: v }))

  async function submit() {
    const r = check(SignUpInput, values)
    if (!r.ok) return setErrors(r.errors)
    setBusy(true)
    setErrors({})
    try {
      setSent(await api<CheckInboxResponse>('/auth/signup', { method: 'POST', body: r.data }))
    } catch (e) {
      setErrors(fromApi(e))
    } finally {
      setBusy(false)
    }
  }

  if (sent) return <CheckInbox sent={sent} onBack={() => navigation.navigate('SignIn')} />

  return (
    <Screen>
      <Title sub="After this you’ll join your company’s workspace with a code.">Create your account</Title>
      <ErrorBox message={errors.form} />
      <Field label="Full name" value={values.name} onChangeText={set('name')} error={errors.name} autoComplete="name" textContentType="name" />
      <Field label="Email" value={values.email} onChangeText={set('email')} error={errors.email} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Field label="Password" value={values.password} onChangeText={set('password')} error={errors.password} hint="At least 8 characters." secureTextEntry autoComplete="new-password" textContentType="newPassword" />
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <Switch value={values.acceptedTerms} onValueChange={set('acceptedTerms')} accessibilityLabel="I agree to the Terms and Privacy Notice" />
        <Text style={{ color: c.fg, flex: 1, fontSize: 14, lineHeight: 20 }}>
          I agree to the Terms and the Privacy Notice, and consent to my personal data being processed under the Data Privacy Act of 2012.
        </Text>
      </View>
      {errors.acceptedTerms ? <Text style={{ color: c.danger, fontSize: 13 }}>{errors.acceptedTerms}</Text> : null}
      <Button title="Create account" onPress={() => void submit()} busy={busy} />
    </Screen>
  )
}

export function ForgotScreen({ navigation }: Props<'Forgot'>) {
  const [email, setEmail] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<CheckInboxResponse | null>(null)

  async function submit() {
    const r = check(EmailInput, { email })
    if (!r.ok) return setErrors(r.errors)
    setBusy(true)
    try {
      setSent(await api<CheckInboxResponse>('/auth/forgot-password', { method: 'POST', body: r.data }))
    } catch (e) {
      setErrors(fromApi(e))
    } finally {
      setBusy(false)
    }
  }

  if (sent) return <CheckInbox sent={sent} onBack={() => navigation.navigate('SignIn')} />
  return (
    <Screen>
      <Title sub="We’ll email you a link. You choose the new password on the web.">Forgot your password?</Title>
      <ErrorBox message={errors.form} />
      <Field label="Email" value={email} onChangeText={setEmail} error={errors.email} autoCapitalize="none" keyboardType="email-address" />
      <Button title="Send reset link" onPress={() => void submit()} busy={busy} />
    </Screen>
  )
}
