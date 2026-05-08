import { KafkaOptions, Transport } from "@nestjs/microservices";
import { read } from "fs";
import { KafkaModuleOptions } from "../interfaces/kafka.interface";


export function createKafkaConfig(options:KafkaModuleOptions):KafkaOptions{
    return {
        transport:Transport.KAFKA
    }
}