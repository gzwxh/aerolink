import {
  FormEvent,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import LoginBanner from '@/assets/login-banner.svg'
import { useAuth } from '@/contexts/auth-context'
import { useBranding } from '@/contexts/branding-context'
import {
  IconEye,
  IconEyeOff,
  IconLock,
  IconRefresh,
  IconUser,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { Navigate, useSearchParams } from 'react-router-dom'

import {
  fetchLoginCaptcha,
  verifyPendingMFA,
  type CredentialProvider,
  type LoginCaptchaChallenge,
} from '@/lib/api'
import { shouldLeaveLoginPage } from '@/lib/login-flow'
import { withSubPath } from '@/lib/subpath'
import { cn } from '@/lib/utils'
import { usePageTitle } from '@/hooks/use-page-title'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Footer } from '@/components/footer'
import { LanguageToggle } from '@/components/language-toggle'

// 登录页背景：横幅插画 + 上下两条轻渐变。
//
// 插画（900×320）的主体云端商城在画面右上角，所以用 object-cover object-right-bottom
// 锚在右下：窗口宽高比与插画不同时裁掉的是左上角的天空，而不是商城和购物袋。
//
// 这里不再整幅压蒙层（会把整个插画的颜色冲淡），只在两条文字带上留一点点背景色：
// 站点标题与语言切换落在深蓝天空上、页脚落在绿色草甸上，纯靠背景色垫一下才能
// 在浅色/深色两种主题下都读得清。中间画面保持插画原色。登录卡片本身不透明，
// 不受影响。
//
// 插画里的云漂移、包裹飞行等都是 SVG SMIL 动画——SMIL 只在图像上下文（img）
// 中播放，CSS background-image 里会被浏览器按静态帧渲染，因此这里用 <img>
// 铺底而不是 backgroundImage。
function LoginBackground({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <img
        src={LoginBanner}
        alt=""
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full object-cover object-right-bottom"
      />
      {/* 只在下缘垫一条很薄的背景色，页脚（灰色小字）压在绿色草甸上才读得清；
          上方标题区不用蒙层，改由标题自身的阴影护读（见下面的 text-shadow）。 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background/80 to-transparent" />
      <div className="relative flex flex-1 flex-col">{children}</div>
    </div>
  )
}

export function LoginPage() {
  const { t } = useTranslation()
  const { logoUrl, isCustomLogo, siteName } = useBranding()
  // 登录页没有子页面标题：浏览器标签只展示控制台名称（同样受品牌配置控制）。
  usePageTitle('')
  const {
    user,
    login,
    loginWithCredentials,
    credentialProviders,
    oauthProviders,
    loginPrompt,
    loginCaptchaEnabled,
    isLoading,
  } = useAuth()
  const [searchParams] = useSearchParams()
  const [loginLoading, setLoginLoading] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaRequired, setMfaRequired] = useState(false)
  // 第三方登录（OIDC）回调会把「待验证」票据带到这里：身份已经在身份源确认过，
  // 只差动态码。票据本身换不到任何权限，见 verifyPendingMFA。
  const [pendingMfaCode, setPendingMfaCode] = useState('')
  const [pendingMfaError, setPendingMfaError] = useState<string | null>(null)
  const [pendingMfaLoading, setPendingMfaLoading] = useState(false)
  const [pendingMfaRestart, setPendingMfaRestart] = useState(false)
  const [captcha, setCaptcha] = useState<LoginCaptchaChallenge | null>(null)
  const [captchaCode, setCaptchaCode] = useState('')
  const [captchaLoading, setCaptchaLoading] = useState(false)
  const [credentialError, setCredentialError] = useState<string | null>(null)
  // 启用时 LDAP 是主要的凭据方式；下面的 effect 在未启用时
  // 回退到第一个可用的提供方。
  const [credentialsProvider, setCredentialsProvider] =
    useState<CredentialProvider>('ldap')

  const error = searchParams.get('error')
  const redirectHref = searchParams.get('href') || ''
  const pendingMfaTicket = searchParams.get('mfa_pending') || ''
  // 被顶下线后从提示弹窗点「重新登录」会带 forced=1：即使浏览器里还留着其它会话的
  // cookie（同一浏览器开了两个标签就会这样），也要先落到登录页——默认行为是已登录
  // 就跳回首页，会把用户直接弹回应用里，看起来像「点了没反应」。
  const [forcedLogin, setForcedLogin] = useState(
    () => searchParams.get('forced') === '1'
  )
  const totalProviders = credentialProviders.length + oauthProviders.length
  const hasAlternativeLogin = oauthProviders.length > 0
  // LDAP 与本地密码共存：LDAP 是主表单，本地
  // 账号通过表单下方的小链接访问（管理员应急
  // 通道），而不是一个显眼的标签页。
  const localEscapeMode =
    credentialProviders.includes('ldap') &&
    credentialProviders.includes('password')
  const loginPromptContent = loginPrompt.trim()
  const loginPromptLines = loginPromptContent
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const credentialSubmitDisabled =
    loginLoading !== null ||
    (mfaRequired && mfaCode.length !== 6) ||
    (loginCaptchaEnabled && captchaCode.length !== 4)

  const refreshCaptcha = useCallback(async () => {
    setCaptchaLoading(true)
    try {
      setCaptcha(await fetchLoginCaptcha())
      setCaptchaCode('')
    } catch (err) {
      console.error('Failed to load captcha:', err)
      setCaptcha(null)
    } finally {
      setCaptchaLoading(false)
    }
  }, [])

  useEffect(() => {
    if (
      credentialProviders.length > 0 &&
      !credentialProviders.includes(credentialsProvider)
    ) {
      setCredentialsProvider(credentialProviders[0])
    }
  }, [credentialProviders, credentialsProvider])

  // 只有安全策略要求时才请求验证码。
  useEffect(() => {
    if (!loginCaptchaEnabled) {
      setCaptcha(null)
      setCaptchaCode('')
      return
    }
    void refreshCaptcha()
  }, [loginCaptchaEnabled, refreshCaptcha])

  // 带着第三方登录的「待验证」票据时必须留在登录页完成动态码校验，
  // 即使浏览器里还留着旧会话——否则这次登录会被旧登录态静默跳过。
  if (
    shouldLeaveLoginPage({
      hasUser: !!user,
      isLoading,
      forcedLogin,
      pendingMfaTicket,
    })
  ) {
    const storedHref = sessionStorage.getItem('loginRedirectHref')
    if (storedHref) {
      sessionStorage.removeItem('loginRedirectHref')
      return <Navigate to={storedHref} replace />
    }
    return <Navigate to={redirectHref || '/'} replace />
  }

  const handleLogin = async (provider: string) => {
    setLoginLoading(provider)
    if (redirectHref) {
      sessionStorage.setItem('loginRedirectHref', redirectHref)
    }
    try {
      await login(provider)
    } catch (error) {
      console.error('Login error:', error)
      sessionStorage.removeItem('loginRedirectHref')
      setLoginLoading(null)
    }
  }

  const handlePendingMfaSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setPendingMfaLoading(true)
    setPendingMfaError(null)
    try {
      await verifyPendingMFA(pendingMfaTicket, pendingMfaCode)
      // 会话 cookie 已由这个响应写入。整页跳转，让应用以已登录状态重新启动——
      // 这里没有可复用的登录态（调用发生在登录页的守卫之外）。
      const storedHref = sessionStorage.getItem('loginRedirectHref')
      sessionStorage.removeItem('loginRedirectHref')
      window.location.href = withSubPath(storedHref || '/')
    } catch (err) {
      const apiErr = err as { code?: string; message?: string }
      if (apiErr.code === 'mfa_pending_invalid') {
        // 票据过期或已被兑换：只能重新走一遍身份源登录。
        setPendingMfaRestart(true)
        setPendingMfaError(t('login.mfaPending.expired'))
      } else if (apiErr.message === 'invalid_mfa_code') {
        setPendingMfaCode('')
        setPendingMfaError(t('login.errors.invalidMfaCode'))
      } else {
        setPendingMfaError(
          apiErr.code
            ? t(`login.errors.${apiErr.code}`, {
                defaultValue: apiErr.message || t('login.errors.unknownError'),
              })
            : apiErr.message || t('login.errors.unknownError')
        )
      }
    } finally {
      setPendingMfaLoading(false)
    }
  }

  const handleCredentialLogin = async (e: FormEvent) => {
    e.preventDefault()
    setLoginLoading(credentialsProvider)
    setCredentialError(null)
    try {
      await loginWithCredentials(
        credentialsProvider,
        username,
        password,
        mfaRequired ? mfaCode : undefined,
        loginCaptchaEnabled && captcha
          ? { idKey: captcha.idKey, code: captchaCode }
          : undefined
      )
      // 强制落到登录页的场景：登录成功后放开守卫，照常跳回原本要去的页面。
      setForcedLogin(false)
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'mfa_required') {
          setMfaRequired(true)
          setCredentialError(null)
          return
        }

        if (err.message === 'invalid_mfa_code') {
          setMfaRequired(true)
          setCredentialError(
            t('login.errors.invalidMfaCode', 'Invalid MFA code')
          )
          return
        }

        // 过期或输错的验证码会被新的挑战替换。
        if (
          err.message === 'invalid_captcha' ||
          err.message === 'captcha_required'
        ) {
          setCredentialError(
            t(
              `login.errors.${err.message}`,
              err.message === 'captcha_required'
                ? 'Please enter the verification code'
                : 'Incorrect verification code'
            )
          )
          void refreshCaptcha()
          return
        }
        // 优先用后端错误码（login_invalid_credentials / login_too_many_attempts
        // 等）做本地化；老响应没有 code 时退回以 message 为 key 的兼容查找。
        const apiErr = err as { code?: string }
        const translated = apiErr.code
          ? t(`login.errors.${apiErr.code}`, { defaultValue: err.message })
          : t(`login.errors.${err.message}`, { defaultValue: err.message })
        setCredentialError(translated || t('login.errors.invalidCredentials'))
      } else {
        setCredentialError(t('login.errors.unknownError'))
      }
    } finally {
      setLoginLoading(null)
    }
  }

  const credentialTabLabel = {
    password: t('common.fields.password', 'Password'),
    ldap: t('login.tabs.ldap', 'LDAP'),
  } satisfies Record<CredentialProvider, string>

  const credentialSubmitLabel = {
    password: t('login.signInWithPassword', 'Sign In with Password'),
    ldap: t('login.signInWithLdap', 'Sign In with LDAP'),
  } satisfies Record<CredentialProvider, string>

  const getErrorMessage = (errorCode: string | null) => {
    if (!errorCode) return null

    // 获取额外参数以给出更详细的错误信息
    const provider = searchParams.get('provider') || 'OAuth provider'
    const user = searchParams.get('user')
    const reason = searchParams.get('reason') || errorCode

    switch (reason) {
      case 'insufficient_permissions':
        return {
          title: t('login.errors.accessDenied'),
          message: user
            ? t('login.errors.insufficientPermissionsUser', { user })
            : t('login.errors.insufficientPermissions'),
          details: t('login.errors.insufficientPermissionsDetails'),
        }
      case 'token_exchange_failed':
        return {
          title: t('login.errors.authenticationFailed'),
          message: t('login.errors.tokenExchangeFailed', { provider }),
          details: t('login.errors.tokenExchangeDetails'),
        }
      case 'user_info_failed':
        return {
          title: t('login.errors.profileAccessFailed'),
          message: t('login.errors.userInfoFailed', { provider }),
          details: t('login.errors.userInfoDetails'),
        }
      case 'jwt_generation_failed':
        return {
          title: t('login.errors.sessionCreationFailed'),
          message: user
            ? t('login.errors.jwtGenerationFailedUser', { user })
            : t('login.errors.jwtGenerationFailed'),
          details: t('login.errors.jwtGenerationDetails'),
        }
      case 'callback_failed':
        return {
          title: t('login.errors.oauthCallbackFailed'),
          message: t('login.errors.callbackFailed'),
          details: t('login.errors.contactSupport'),
        }
      case 'callback_error':
        return {
          title: t('login.errors.authenticationError'),
          message: t('login.errors.callbackError'),
          details: t('login.errors.contactSupport'),
        }
      case 'user_disabled':
        return {
          title: t('login.errors.userDisabled', 'User Disabled'),
          message: t('login.errors.userDisabledMessage'),
        }
      case 'user_expired':
        return {
          title: t('login.errors.userExpired', 'Account Expired'),
          message: t('login.errors.userExpiredMessage'),
        }
      case 'user_not_provisioned':
        return {
          title: t(
            'login.errors.userNotProvisioned',
            'Account Not Provisioned'
          ),
          message: t('login.errors.userNotProvisionedMessage', { user }),
        }
      case 'login_source_denied':
        return {
          title: t(
            'login.errors.loginSourceDenied',
            'Login Source Not Allowed'
          ),
          message: t('login.errors.loginSourceDeniedMessage'),
        }
      case 'not_in_allowed_groups':
        return {
          title: t('login.errors.accessDenied'),
          message: t('login.errors.notInAllowedGroups', { provider }),
          details: t('login.errors.notInAllowedGroupsDetails'),
        }
      default:
        return {
          title: t('login.errors.authenticationError'),
          message: t('login.errors.generalError'),
          details: t('login.errors.contactSupport'),
        }
    }
  }

  if (isLoading) {
    return (
      <LoginBackground>
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
        </div>
      </LoginBackground>
    )
  }

  return (
    <LoginBackground>
      {/* Language Toggle - Top Right */}
      {/* 右上角压在插画的光斑上，给个浅底以保证图标在两种主题下都看得见 */}
      <div className="absolute top-6 right-6 z-10 rounded-full bg-background/50 backdrop-blur-sm">
        <LanguageToggle />
      </div>

      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="flex items-center justify-center space-x-2 mb-4">
              <img
                src={logoUrl}
                alt={siteName}
                className={cn(
                  'h-10 w-10',
                  !isCustomLogo && 'dark:invert',
                  // 背景是插画（这一带是深蓝天空），用阴影把 logo 与标题托起来，
                  // 这样不必再给整幅背景压蒙层。
                  'drop-shadow-[0_1px_6px_rgba(255,255,255,0.9)] dark:drop-shadow-[0_1px_6px_rgba(0,0,0,0.9)]'
                )}
              />{' '}
              <h1 className="text-2xl font-bold [text-shadow:0_1px_10px_rgba(255,255,255,0.9)] dark:[text-shadow:0_1px_10px_rgba(0,0,0,0.9)]">
                {siteName}
              </h1>
            </div>
          </div>

          <Card className="shadow-lg">
            <CardHeader className="text-center">
              <CardTitle className="text-xl">{t('login.signIn')}</CardTitle>
              {/* 默认说明与管理员自定义登录提示二选一，避免两段文案重复冲突 */}
              {loginPromptLines.length === 0 && (
                <CardDescription className="text-gray-600">
                  {t('login.subtitle')}
                </CardDescription>
              )}
              {loginPromptLines.map((line, index) => (
                <p
                  key={`${index}-${line}`}
                  className="text-sm text-gray-500 mt-2"
                >
                  {line}
                </p>
              ))}
            </CardHeader>
            <CardContent className="space-y-4">
              {error && (
                <div className="space-y-3">
                  <Alert className="border-red-200 bg-red-50">
                    <AlertDescription className="text-red-700">
                      <div className="space-y-2">
                        <div className="font-semibold">
                          {getErrorMessage(error)?.title}
                        </div>
                        <div>{getErrorMessage(error)?.message}</div>
                        {getErrorMessage(error)?.details && (
                          <div className="text-sm text-red-600 mt-2">
                            {getErrorMessage(error)?.details}
                          </div>
                        )}
                      </div>
                    </AlertDescription>
                  </Alert>

                  {/* Additional actions for permission errors */}
                  {(searchParams.get('reason') === 'insufficient_permissions' ||
                    error === 'insufficient_permissions') && (
                    <div className="text-center space-y-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          window.location.href = withSubPath('/login')
                        }}
                        className="w-full"
                      >
                        {t('login.tryAgainDifferentAccount')}
                      </Button>
                      <p className="text-xs text-gray-500">
                        {t('login.tryAgainHint')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {!pendingMfaTicket && totalProviders === 0 ? (
                <div className="text-center py-8">
                  <p className="text-gray-600">{t('login.noLoginMethods')}</p>
                  <p className="text-sm text-gray-500 mt-2">
                    {t('login.configureAuth')}
                  </p>
                </div>
              ) : pendingMfaTicket ? (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">
                      {t('login.mfaPending.title')}
                    </p>
                    <p className="text-sm text-gray-500">
                      {t('login.mfaPending.description')}
                    </p>
                  </div>
                  <form onSubmit={handlePendingMfaSubmit} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="pendingMfaCode">
                        {t('login.mfaPending.codeLabel')}
                      </Label>
                      <Input
                        id="pendingMfaCode"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        placeholder={t('login.mfaPending.codePlaceholder')}
                        value={pendingMfaCode}
                        onChange={(e) =>
                          setPendingMfaCode(
                            e.target.value.replace(/\D/g, '').slice(0, 6)
                          )
                        }
                        autoFocus
                        required
                      />
                    </div>
                    {pendingMfaError && (
                      <Alert variant="destructive">
                        <AlertDescription>{pendingMfaError}</AlertDescription>
                      </Alert>
                    )}
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={
                        pendingMfaLoading || pendingMfaCode.length !== 6
                      }
                    >
                      {pendingMfaLoading ? (
                        <span className="flex items-center space-x-2">
                          <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></span>
                          <span>{t('login.signingIn')}</span>
                        </span>
                      ) : (
                        t('login.mfaPending.submit')
                      )}
                    </Button>
                    {pendingMfaRestart && (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          window.location.href = withSubPath('/login')
                        }}
                      >
                        {t('login.mfaPending.restart')}
                      </Button>
                    )}
                  </form>
                </div>
              ) : (
                <div className="space-y-4">
                  {credentialProviders.length > 0 && (
                    <div className="space-y-4">
                      {credentialProviders.length > 1 && !localEscapeMode && (
                        <Tabs
                          value={credentialsProvider}
                          onValueChange={(value) => {
                            if (value === 'password' || value === 'ldap') {
                              setCredentialsProvider(value)
                              setCredentialError(null)
                              setMfaRequired(false)
                              setMfaCode('')
                            }
                          }}
                        >
                          <TabsList
                            className={`grid w-full ${
                              credentialProviders.length > 1
                                ? 'grid-cols-2'
                                : 'grid-cols-1'
                            }`}
                          >
                            {credentialProviders.map((provider) => (
                              <TabsTrigger key={provider} value={provider}>
                                {credentialTabLabel[provider]}
                              </TabsTrigger>
                            ))}
                          </TabsList>
                        </Tabs>
                      )}

                      <form
                        onSubmit={handleCredentialLogin}
                        className="space-y-4"
                      >
                        <div className="space-y-2">
                          <Label htmlFor="username">
                            {t('common.fields.username')}
                          </Label>
                          <div className="relative">
                            <IconUser className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                              id="username"
                              type="text"
                              placeholder={t('login.enterUsername')}
                              value={username}
                              onChange={(e) => {
                                setUsername(e.target.value)
                                setMfaRequired(false)
                                setMfaCode('')
                              }}
                              className="pl-9"
                              required
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="password">
                            {t('common.fields.password')}
                          </Label>
                          <div className="relative">
                            <IconLock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                              id="password"
                              type={showPassword ? 'text' : 'password'}
                              placeholder={t('login.enterPassword')}
                              value={password}
                              onChange={(e) => {
                                setPassword(e.target.value)
                                setMfaRequired(false)
                                setMfaCode('')
                              }}
                              className="pl-9 pr-10"
                              required
                            />
                            <button
                              type="button"
                              aria-label={
                                showPassword
                                  ? t('login.hidePassword', 'Hide password')
                                  : t('login.showPassword', 'Show password')
                              }
                              onClick={() => setShowPassword((show) => !show)}
                              className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            >
                              {showPassword ? (
                                <IconEyeOff className="h-4 w-4" />
                              ) : (
                                <IconEye className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                        </div>
                        {loginCaptchaEnabled && (
                          <div className="space-y-2">
                            <Label htmlFor="captchaCode">
                              {t('login.captchaLabel', 'Verification code')}
                            </Label>
                            <div className="flex items-center gap-2">
                              <Input
                                id="captchaCode"
                                type="text"
                                inputMode="numeric"
                                autoComplete="off"
                                maxLength={4}
                                placeholder={t(
                                  'login.captchaPlaceholder',
                                  'Enter the 4-digit code'
                                )}
                                value={captchaCode}
                                onChange={(e) =>
                                  setCaptchaCode(
                                    e.target.value
                                      .replace(/\D/g, '')
                                      .slice(0, 4)
                                  )
                                }
                                required
                              />
                              <button
                                type="button"
                                onClick={() => void refreshCaptcha()}
                                aria-label={t(
                                  'login.refreshCaptcha',
                                  'Refresh code'
                                )}
                                title={t(
                                  'login.refreshCaptcha',
                                  'Refresh code'
                                )}
                                className="flex h-[44px] w-[120px] shrink-0 items-center justify-center overflow-hidden rounded-md border bg-white"
                              >
                                {captcha ? (
                                  <img
                                    src={captcha.image}
                                    alt={t(
                                      'login.captchaLabel',
                                      'Verification code'
                                    )}
                                    className="h-[44px] w-[120px]"
                                  />
                                ) : (
                                  <IconRefresh
                                    className={`h-4 w-4 text-muted-foreground ${
                                      captchaLoading ? 'animate-spin' : ''
                                    }`}
                                  />
                                )}
                              </button>
                            </div>
                          </div>
                        )}
                        {mfaRequired && (
                          <div className="space-y-2">
                            <Label htmlFor="mfaCode">MFA Code</Label>
                            <Input
                              id="mfaCode"
                              type="text"
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              maxLength={6}
                              placeholder="Enter 6-digit code"
                              value={mfaCode}
                              onChange={(e) =>
                                setMfaCode(
                                  e.target.value.replace(/\D/g, '').slice(0, 6)
                                )
                              }
                              required
                            />
                          </div>
                        )}
                        {credentialError && (
                          <Alert variant="destructive">
                            <AlertDescription>
                              {credentialError}
                            </AlertDescription>
                          </Alert>
                        )}
                        <Button
                          type="submit"
                          disabled={credentialSubmitDisabled}
                          className="w-full h-10"
                        >
                          {loginLoading === credentialsProvider ? (
                            <div className="flex items-center space-x-2">
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2"></div>
                              <span>{t('login.signingIn')}</span>
                            </div>
                          ) : mfaRequired ? (
                            'Verify MFA'
                          ) : (
                            credentialSubmitLabel[credentialsProvider]
                          )}
                        </Button>
                      </form>

                      {localEscapeMode && (
                        <button
                          type="button"
                          className="mx-auto block text-xs text-muted-foreground transition-colors hover:text-primary"
                          onClick={() => {
                            setCredentialsProvider(
                              credentialsProvider === 'ldap'
                                ? 'password'
                                : 'ldap'
                            )
                            setCredentialError(null)
                            setMfaRequired(false)
                            setMfaCode('')
                          }}
                        >
                          {credentialsProvider === 'ldap'
                            ? t(
                                'login.useLocalAccount',
                                'Sign in with a local account'
                              )
                            : t('login.useLdapAccount', 'Sign in with LDAP')}
                        </button>
                      )}
                    </div>
                  )}

                  {hasAlternativeLogin && (
                    <div className="space-y-3">
                      {credentialProviders.length > 0 && (
                        <div className="relative">
                          <div className="absolute inset-0 flex items-center">
                            <span className="w-full border-t" />
                          </div>
                          <div className="relative flex justify-center text-xs uppercase">
                            <span className="px-2 text-muted-foreground bg-card rounded">
                              {t('login.orContinueWith')}
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="space-y-2">
                        {oauthProviders.map((provider) => (
                          <Button
                            key={provider}
                            type="button"
                            onClick={() => handleLogin(provider)}
                            disabled={loginLoading !== null}
                            className="w-full h-10 text-foreground"
                            variant="outline"
                          >
                            {loginLoading === provider ? (
                              <span className="flex items-center space-x-2">
                                <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></span>
                                <span>{t('login.signingIn')}</span>
                              </span>
                            ) : (
                              <span>
                                {t('login.signInWith', {
                                  provider:
                                    provider.charAt(0).toUpperCase() +
                                    provider.slice(1),
                                })}
                              </span>
                            )}
                          </Button>
                        ))}
                        {credentialProviders.length === 0 &&
                          credentialError && (
                            <Alert variant="destructive">
                              <AlertDescription>
                                {credentialError}
                              </AlertDescription>
                            </Alert>
                          )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Footer */}
      <Footer />
    </LoginBackground>
  )
}
