import { createCn } from "cn/config";

/**
 * `text-12 … text-72` are font-size tokens in this app's theme. Without this
 * extension the merger reads them as text colours and drops them whenever a
 * colour class (`text-primary-white`) appears in the same call.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "12",
            "14",
            "16",
            "18",
            "20",
            "22",
            "24",
            "28",
            "32",
            "40",
            "44",
            "56",
            "72",
          ],
        },
      ],
    },
  },
});
