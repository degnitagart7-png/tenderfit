import {
  getArchiveCli,
  makeTempDir,
  type ArchiveCli,
} from "@/services/archiveCli";
import {
  parseArchiveVolumeFiles,
  parseAttachmentFile,
} from "@/services/attachmentParser";
import type { AttachmentDiskDeps } from "@/services/tenderAttachmentsFetcher";

/**
 * Дисковый путь для обхода вложений: настоящие порты поверх archiveCli и
 * attachmentParser. Серверный модуль — подключается скриптами загрузки и
 * повторного разбора и воркером; клиентскому коду он не нужен.
 *
 * `archiveCli` передают тесты и вызывающий код, который уже нашёл программы;
 * по умолчанию программы ищутся на машине один раз за процесс. Нет ни 7z, ни
 * unrar — `available()` отвечает false, и обход идёт в памяти с прежними
 * пределами.
 */
export function createAttachmentDisk(
  options: { archiveCli?: ArchiveCli | null } = {},
): AttachmentDiskDeps {
  const resolve = async (): Promise<ArchiveCli | null> =>
    options.archiveCli !== undefined ? options.archiveCli : await getArchiveCli();

  return {
    available: async () => (await resolve()) !== null,

    async makeDir() {
      const cli = await resolve();
      return makeTempDir("tenderfit-spool-", cli?.tmpRoot);
    },

    async parseFile(path, filename, contentType, budgetChars) {
      return parseAttachmentFile(path, filename, contentType, budgetChars, {
        archiveCli: await resolve(),
      });
    },

    async parseVolumeFiles(volumes, budgetChars) {
      return parseArchiveVolumeFiles(volumes, budgetChars, {
        archiveCli: await resolve(),
      });
    },
  };
}
