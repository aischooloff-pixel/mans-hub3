import { useState, useEffect } from 'react';
import { X, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useProfile } from '@/hooks/use-profile';
import { toast } from 'sonner';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { profile, updatePrivacy } = useProfile();

  const [privacy, setPrivacy] = useState({
    showAvatar: true,
    showName: true,
    showUsername: true,
  });

  // Sync privacy state with profile when it loads
  useEffect(() => {
    if (profile) {
      setPrivacy({
        showAvatar: profile.show_avatar ?? true,
        showName: profile.show_name ?? true,
        showUsername: profile.show_username ?? true,
      });
    }
  }, [profile]);

  const handlePrivacyChange = async (key: 'showAvatar' | 'showName' | 'showUsername', value: boolean) => {
    const newPrivacy = { ...privacy, [key]: value };
    setPrivacy(newPrivacy);

    const success = await updatePrivacy({
      show_avatar: newPrivacy.showAvatar,
      show_name: newPrivacy.showName,
      show_username: newPrivacy.showUsername,
    });

    if (success) {
      toast.success('Настройки приватности обновлены');
    } else {
      // Revert on error
      setPrivacy(privacy);
      toast.error('Ошибка сохранения');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      {/* Modal */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl bg-card animate-slide-up',
          'md:inset-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg'
        )}
      >
        {/* Handle bar for mobile */}
        <div className="sticky top-0 z-10 flex justify-center bg-card pt-3 md:hidden">
          <div className="h-1 w-12 rounded-full bg-border" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-muted-foreground" />
            <h2 className="font-heading text-lg font-semibold">Настройки приватности</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Content */}
        <div className="p-4">
          <p className="text-sm text-muted-foreground mb-4">
            Управляйте тем, что видят другие пользователи
          </p>

          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg bg-secondary/50 p-4">
              <div>
                <p className="font-medium">Показывать аватар</p>
                <p className="text-xs text-muted-foreground">Если скрыто, отображается дефолтный аватар</p>
              </div>
              <Switch
                checked={privacy.showAvatar}
                onCheckedChange={(checked) => handlePrivacyChange('showAvatar', checked)}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg bg-secondary/50 p-4">
              <div>
                <p className="font-medium">Показывать имя</p>
                <p className="text-xs text-muted-foreground">Если скрыто, отображается «Аноним»</p>
              </div>
              <Switch
                checked={privacy.showName}
                onCheckedChange={(checked) => handlePrivacyChange('showName', checked)}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg bg-secondary/50 p-4">
              <div>
                <p className="font-medium">Показывать username</p>
                <p className="text-xs text-muted-foreground">Если скрыто, отображается «@скрыт»</p>
              </div>
              <Switch
                checked={privacy.showUsername}
                onCheckedChange={(checked) => handlePrivacyChange('showUsername', checked)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
