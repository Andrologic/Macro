import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Image } from '@tauri-apps/api/image';

export function useDynamicAppIcon(primaryColor?: string) {
  useEffect(() => {
    const updateIcon = async () => {
      // Basic check to see if we are likely in a Tauri environment
      // @ts-ignore
      if (typeof window !== 'undefined' && !window.__TAURI_INTERNALS__) {
        return;
      }

      if (!primaryColor) return;

      try {
        // We use the same path from Logo.tsx but render it to a string
        const svgString = `
          <svg width="128" height="128" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="icon-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="${primaryColor}" />
                <stop offset="100%" stop-color="color-mix(in srgb, ${primaryColor}, black 20%)" />
              </linearGradient>
            </defs>
            <g transform="rotate(-90 12 12)">
              <path
                d="M 21,12 4,4 c 2,5 2,11 0,16 z"
                stroke="url(#icon-grad)"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </g>
          </svg>
        `;

        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const img = new window.Image();
        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);

        img.onload = async () => {
          ctx.drawImage(img, 0, 0, 128, 128);
          URL.revokeObjectURL(url);

          try {
            const imageData = ctx.getImageData(0, 0, 128, 128);
            const rgba = new Uint8Array(imageData.data.buffer);
            
            // Create Tauri Image from raw RGBA bytes
            // @ts-ignore - API signature might vary slightly in betas, but this is standard v2
            const icon = await Image.new(rgba, 128, 128);
            await getCurrentWindow().setIcon(icon);
          } catch (e) {
            console.error('Failed to set app icon (likely Wayland or permission issue):', e);
          }
        };

        img.src = url;

      } catch (err) {
        console.error('Error updating app icon:', err);
      }
    };

    updateIcon();
  }, [primaryColor]);
}
