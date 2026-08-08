import type { SkillManifest, SkillScriptRunResult } from '../../types';
import { getSkillLocation } from './identity';

const formatSkillResources = (skill: SkillManifest): string => {
  const resources = skill.resources.map((resource) =>
    `- ${resource.path} (${resource.kind}, ${resource.sizeBytes} bytes)`,
  );
  return resources.join('\n') || '- None discovered.';
};

const formatSkillScripts = (skill: SkillManifest): string => {
  const scripts = skill.scripts.map((script) =>
    `- ${script.path} (${script.sizeBytes} bytes)`,
  );
  return scripts.join('\n') || '- None discovered.';
};

const escapeSkillAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const formatSkillSource = (skill: SkillManifest): string =>
  `${skill.source.kind}/${skill.source.namespace ?? 'agents'}`;

export const formatSkillActivationBlock = (
  skill: SkillManifest,
  body: string,
  alreadyLoaded: boolean,
): string => {
  const location = getSkillLocation(skill);
  const attributes = [
    `name="${escapeSkillAttribute(skill.name)}"`,
    `id="${escapeSkillAttribute(skill.id)}"`,
    `source="${escapeSkillAttribute(formatSkillSource(skill))}"`,
    `location_kind="${escapeSkillAttribute(location.kind)}"`,
    `location_uri="${escapeSkillAttribute(location.uri)}"`,
    skill.contentHash ? `content_hash="${escapeSkillAttribute(skill.contentHash)}"` : '',
    alreadyLoaded ? 'already_loaded="true"' : '',
  ].filter(Boolean).join(' ');

  const headerLines = [
    `# Skill: ${skill.name}`,
    '',
    skill.description,
    '',
    `Source: ${formatSkillSource(skill)}`,
    `Location: ${location.kind}:${location.uri}`,
    skill.compatibility ? `Compatibility: ${skill.compatibility}` : '',
    skill.license ? `License: ${skill.license}` : '',
    skill.specCompliant === false
      ? 'Spec compliance: warnings present; Macro loaded this skill leniently.'
      : 'Spec compliance: compliant or not reported.',
    skill.allowedTools
      ? `Allowed tools requested by skill (advisory only): ${skill.allowedTools}`
      : '',
    skill.shadowedBySkillId
      ? `Shadowed by: ${skill.shadowedBySkillId}. This exact id was selected explicitly.`
      : '',
  ].filter(Boolean);

  return [
    `<skill_content ${attributes}>`,
    ...headerLines,
    '',
    '## Instructions',
    body.trim() || '(No body instructions.)',
    '',
    '## Bundled Resources',
    formatSkillResources(skill),
    '',
    '## Bundled Scripts',
    formatSkillScripts(skill),
    '',
    'Resources, assets, and scripts are listed only. They are not loaded by activation. Use skill_read_resource for listed resources/assets and skill_run_script only when explicitly useful and allowed by Macro policy.',
    '</skill_content>',
  ].join('\n');
};

export const formatScriptResult = (result: SkillScriptRunResult): string => [
  `skill_id: ${result.skillId}`,
  `script_path: ${result.scriptPath}`,
  `exit_code: ${result.exitCode ?? 'none'}`,
  `timed_out: ${result.timedOut ? 'true' : 'false'}`,
  result.truncated ? 'output_truncated: true' : '',
  result.stdout ? `\nSTDOUT:\n${result.stdout}` : '',
  result.stderr ? `\nSTDERR:\n${result.stderr}` : '',
].filter(Boolean).join('\n');
