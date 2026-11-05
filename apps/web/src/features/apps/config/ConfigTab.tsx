/** Configuration tab: Coolify-style sub-navigation with one form section per page. */
import type { App, Server } from '@docksy/shared';
import { SubNavLayout } from '../../../components/ui.tsx';
import { BackupsTab } from '../BackupsTab.tsx';
import { EnvSection } from './EnvSection.tsx';
import { GeneralSection, SourceSection } from './GeneralSection.tsx';
import { DangerSection, HealthSection, LimitsSection, StorageSection, WebhooksSection } from './MoreSections.tsx';

export type ConfigSectionId = 'general' | 'source' | 'environment' | 'storage' | 'healthcheck' | 'limits' | 'webhooks' | 'backups' | 'danger';

export function configSections(app: App, backups: boolean): { id: ConfigSectionId; label: string; hidden?: boolean; danger?: boolean }[] {
  return [
    { id: 'general', label: 'General' },
    { id: 'source', label: app.sourceType === 'git' ? 'Git Source' : 'Image Source' },
    { id: 'environment', label: 'Environment Variables' },
    { id: 'storage', label: 'Persistent Storage' },
    { id: 'healthcheck', label: 'Health Check' },
    { id: 'limits', label: 'Resource Limits' },
    { id: 'webhooks', label: 'Webhooks' },
    { id: 'backups', label: 'Backups', hidden: !backups },
    { id: 'danger', label: 'Danger Zone', danger: true },
  ];
}

export function ConfigTab({ app, server, section, onSection, deployed, backups }: {
  app: App; server?: Server; section: ConfigSectionId; onSection: (id: string) => void; deployed: boolean; backups: boolean;
}) {
  return (
    <SubNavLayout items={configSections(app, backups)} value={section} onChange={onSection}>
      <div key={section} className="max-w-[1100px]">
        {section === 'general' && <GeneralSection app={app} deployed={deployed} />}
        {section === 'source' && <SourceSection app={app} />}
        {section === 'environment' && <EnvSection app={app} />}
        {section === 'storage' && <StorageSection app={app} />}
        {section === 'healthcheck' && <HealthSection app={app} />}
        {section === 'limits' && <LimitsSection app={app} server={server} />}
        {section === 'webhooks' && <WebhooksSection app={app} onSection={onSection} />}
        {section === 'backups' && <BackupsTab app={app} />}
        {section === 'danger' && <DangerSection app={app} />}
      </div>
    </SubNavLayout>
  );
}
