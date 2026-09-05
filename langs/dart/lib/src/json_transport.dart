import 'client.dart';
import 'models.dart';

typedef JsonWriteTransport = Future<JsonMap> Function(JsonMap queuedWrite);
typedef JsonPullTransport = Future<JsonMap> Function(int cursor, int limit);

/// Adapt `fiducia_client`'s dependency-free JSON sync sender to the strongly
/// typed callback consumed by [FiduciaSyncClient].
SendWrite adaptJsonSender(JsonWriteTransport send) {
  return (write) async {
    final acknowledgement = WriteAcknowledgement.fromJson(
      await send(write.toWireJson()),
    );
    if (acknowledgement.id != write.id) {
      throw const FormatException(
        'sync acknowledgement id does not match the queued write',
      );
    }
    return acknowledgement;
  };
}

/// Adapt `fiducia_client`'s JSON catch-up callback to typed pull pages.
PullChanges adaptJsonPuller(JsonPullTransport pull) {
  return (cursor, limit) async => PullPage.fromJson(await pull(cursor, limit));
}
