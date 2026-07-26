import {
  EmbedTab,
  FilePanel,
  type FilePanelProps,
  UploadTab,
  useBlockNoteEditor,
} from "@blocknote/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { UnsplashPicker } from "@/components/UnsplashPicker";
import { fileUrl } from "@/lib/api";
import { creditLine } from "@/lib/credit";
import { useUnsplashAvailable } from "@/lib/unsplashStatus";

/**
 * Panel of a media block: the two default tabs (Upload / Embed) plus an Unsplash
 * tab when the installation has a key configured.
 *
 * Picking a photo sets the block's `url` to the mirrored local file AND its
 * `caption` to the photographer's credit — the caption is the display slot the
 * Unsplash terms require, and it follows the block into the Markdown export.
 */
export function EditorFilePanel(props: FilePanelProps) {
  const { t } = useTranslation();
  const editor = useBlockNoteEditor();
  const [loading, setLoading] = useState(false);
  const unsplashAvailable = useUnsplashAvailable();

  const tabs = [
    {
      name: t("editor.filePanel.upload"),
      tabPanel: <UploadTab blockId={props.blockId} setLoading={setLoading} />,
    },
    {
      name: t("editor.filePanel.embed"),
      tabPanel: <EmbedTab blockId={props.blockId} />,
    },
    ...(unsplashAvailable
      ? [
          {
            name: t("editor.filePanel.unsplash"),
            tabPanel: (
              <div className="w-[min(28rem,80vw)] p-2">
                <UnsplashPicker
                  onPicked={(picked) => {
                    const block = editor.getBlock(props.blockId);
                    if (!block) return;
                    const caption = picked.credit
                      ? creditLine(picked.credit, {
                          by: t("credit.photoBy"),
                          on: t("credit.on"),
                        })
                      : "";
                    editor.updateBlock(block, {
                      type: "image",
                      props: { url: fileUrl(picked.hash), caption },
                    });
                  }}
                />
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div aria-busy={loading}>
      <FilePanel {...props} tabs={tabs} />
    </div>
  );
}
