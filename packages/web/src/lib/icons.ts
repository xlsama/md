import alignLeft from '@iconify-icons/lucide/align-left';
import chevronLeft from '@iconify-icons/lucide/chevron-left';
import chevronRight from '@iconify-icons/lucide/chevron-right';
import chevronsRight from '@iconify-icons/lucide/chevrons-right';
import filePlus from '@iconify-icons/lucide/file-plus';
import fileText from '@iconify-icons/lucide/file-text';
import folderPlus from '@iconify-icons/lucide/folder-plus';
import imageOff from '@iconify-icons/lucide/image-off';
import lock from '@iconify-icons/lucide/lock';
import moon from '@iconify-icons/lucide/moon';
import panelLeftClose from '@iconify-icons/lucide/panel-left-close';
import panelLeftOpen from '@iconify-icons/lucide/panel-left-open';
import pencil from '@iconify-icons/lucide/pencil';
import plus from '@iconify-icons/lucide/plus';
import search from '@iconify-icons/lucide/search';
import settings from '@iconify-icons/lucide/settings';
import sun from '@iconify-icons/lucide/sun';
import trash from '@iconify-icons/lucide/trash-2';
import x from '@iconify-icons/lucide/x';
import zoomIn from '@iconify-icons/lucide/zoom-in';
import zoomOut from '@iconify-icons/lucide/zoom-out';

/**
 * Icon data is imported per glyph so the bundle carries exactly the icons we
 * use — nothing is fetched from the Iconify API at runtime.
 */
export const icons = {
  'align-left': alignLeft,
  'chevron-left': chevronLeft,
  'chevron-right': chevronRight,
  'chevrons-right': chevronsRight,
  'file-plus': filePlus,
  'file-text': fileText,
  'folder-plus': folderPlus,
  'image-off': imageOff,
  lock,
  moon,
  'panel-left-close': panelLeftClose,
  'panel-left-open': panelLeftOpen,
  pencil,
  plus,
  search,
  settings,
  sun,
  trash,
  x,
  'zoom-in': zoomIn,
  'zoom-out': zoomOut,
};

export type IconName = keyof typeof icons;
