import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { verifyCurrentUserMFA } from '@/lib/api'
import { MFA_PROMPT_EVENT, resolveMFAVerification } from '@/lib/mfa-prompt'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Step-up prompt for sensitive operations. The API client opens it when the
 * backend answers `mfa_verification_required` and replays the request once the
 * code is accepted.
 */
export function MFAPromptDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [isPending, setIsPending] = useState(false)

  useEffect(() => {
    const handlePrompt = () => {
      setCode('')
      setError('')
      setOpen(true)
    }
    window.addEventListener(MFA_PROMPT_EVENT, handlePrompt)
    return () => window.removeEventListener(MFA_PROMPT_EVENT, handlePrompt)
  }, [])

  const handleOpenChange = (next: boolean) => {
    if (next || isPending) {
      return
    }
    setOpen(false)
    resolveMFAVerification(false)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setIsPending(true)
    setError('')
    try {
      await verifyCurrentUserMFA(code)
      setOpen(false)
      resolveMFAVerification(true)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('mfaPrompt.failed', 'Verification failed')
      )
    } finally {
      setIsPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t('mfaPrompt.title', 'MFA verification required')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'mfaPrompt.description',
              'This operation is sensitive. Enter the code from your authenticator app to continue.'
            )}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="mfa-prompt-code">
              {t('mfaPrompt.codeLabel', 'Verification code')}
            </Label>
            <Input
              id="mfa-prompt-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
              }
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isPending}
            >
              {t('common.actions.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={isPending || code.length !== 6}>
              {t('mfaPrompt.verify', 'Verify')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
