import filePlus from '@iconify-icons/lucide/file-plus';
import fileText from '@iconify-icons/lucide/file-text';
import folderPlus from '@iconify-icons/lucide/folder-plus';
import pencil from '@iconify-icons/lucide/pencil';
import plus from '@iconify-icons/lucide/plus';
import trash from '@iconify-icons/lucide/trash-2';

/**
 * Icon data is imported per glyph so the bundle carries exactly the icons we
 * use — nothing is fetched from the Iconify API at runtime.
 */
export const icons = {
  'file-plus': filePlus,
  'file-text': fileText,
  'folder-plus': folderPlus,
  pencil,
  plus,
  trash,
};

export type IconName = keyof typeof icons;
