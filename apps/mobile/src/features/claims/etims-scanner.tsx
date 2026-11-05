import type { BarcodeScanningResult } from "expo-camera";
import type { JSX } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef } from "react";
import { Linking, Modal, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "~/components/button";
import { Text } from "~/components/text";

const QR_ONLY = { barcodeTypes: ["qr" as const] };

/**
 * A full-screen camera that reads one QR code and closes (spec §6.4). The
 * payload goes back exactly as scanned; the caller decides what it is.
 */
export function EtimsScanner({
  visible,
  onScanned,
  onClose,
}: {
  visible: boolean;
  onScanned: (payload: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);

  function handleScan({ data }: BarcodeScanningResult): void {
    if (scanned.current || data.trim() === "") return;
    scanned.current = true;
    onScanned(data);
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      onShow={() => {
        scanned.current = false;
      }}
    >
      <SafeAreaView className="flex-1 gap-6 bg-black px-6 py-6">
        <Text
          accessibilityRole="header"
          className="text-xl font-bold text-white"
        >
          Scan the eTIMS QR code
        </Text>
        {permission?.granted ? (
          <View className="flex-1 overflow-hidden rounded-2xl">
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={QR_ONLY}
              onBarcodeScanned={handleScan}
            />
          </View>
        ) : (
          <View className="flex-1 justify-center gap-4">
            <Text className="text-base text-white">
              Expendi Business needs the camera to read the QR code on the
              receipt.
            </Text>
            {permission && !permission.canAskAgain ? (
              <Button
                label="Open Settings"
                variant="secondary"
                onPress={() => void Linking.openSettings()}
              />
            ) : (
              <Button
                label="Allow camera"
                variant="secondary"
                onPress={() => void requestPermission()}
              />
            )}
          </View>
        )}
        <Text className="text-sm text-gray-300">
          Hold the receipt flat and fit the QR code in the frame.
        </Text>
        <Button label="Cancel" variant="secondary" onPress={onClose} />
      </SafeAreaView>
    </Modal>
  );
}
