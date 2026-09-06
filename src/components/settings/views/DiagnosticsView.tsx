import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  appDiagnosticGenerate,
  appDiagnosticSave,
  type AppDiagnosticReportPreviewDto,
} from '../../../services/tauriIpc';
import { save } from '../../../services/tauriDialog';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Textarea } from '../../ui/Textarea';
import { notify } from '../../ui/toastService';
import { SettingsSectionHeader } from '../SettingsSectionHeader';

export const DiagnosticsView: React.FC = () => {
  const { t } = useTranslation();
  const [report, setReport] = useState<AppDiagnosticReportPreviewDto | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);

  const generate = async () => {
    setGenerating(true);
    try {
      setReport(await appDiagnosticGenerate());
    } catch (error) {
      notify.error(t('settings.diagnostic.generateFailed', 'Could not generate the diagnostic report'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setGenerating(false);
    }
  };

  const saveReport = async () => {
    if (!report) return;
    const path = await save({
      title: t('settings.diagnostic.saveTitle', 'Save diagnostic report'),
      defaultPath: report.suggestedFileName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!path) return;
    setSaving(true);
    try {
      await appDiagnosticSave(report.reportId, path);
      notify.success(t('settings.diagnostic.saved', 'Diagnostic report saved'));
    } catch (error) {
      notify.error(t('settings.diagnostic.saveFailed', 'Could not save the diagnostic report'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSectionHeader
        title={t('settings.diagnostic.title', 'Local diagnostic report')}
        description={t(
          'settings.diagnostic.description',
          'Review a redacted report before saving it for support. Nothing is sent automatically.',
        )}
      />

      <div className="rounded-lg border border-border bg-card/40 p-4">
        <p className="text-sm text-foreground">
          {t(
            'settings.diagnostic.contents',
            'The report contains the Macro version, non-secret effective settings, database and recovery health, MCP and updater states, and bounded log metadata.',
          )}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {t(
            'settings.diagnostic.exclusions',
            'Secrets, prompts, source code, private paths, user content, and raw log messages are excluded.',
          )}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            isLoading={generating}
            onClick={() => void generate()}
            leftIcon={<Icon name="file-text" size={14} />}
          >
            {report
              ? t('settings.diagnostic.regenerate', 'Regenerate preview')
              : t('settings.diagnostic.generate', 'Generate preview')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            isLoading={saving}
            disabled={!report}
            onClick={() => void saveReport()}
            leftIcon={<Icon name="save" size={14} />}
          >
            {t('settings.diagnostic.save', 'Save report')}
          </Button>
        </div>
      </div>

      {report ? (
        <div className="space-y-2">
          <label htmlFor="diagnostic-preview" className="text-sm font-medium text-foreground">
            {t('settings.diagnostic.preview', 'Report preview')}
          </label>
          <Textarea
            id="diagnostic-preview"
            readOnly
            spellCheck={false}
            value={report.content}
            className="min-h-80 resize-y font-mono text-xs leading-5"
          />
        </div>
      ) : null}
    </div>
  );
};
