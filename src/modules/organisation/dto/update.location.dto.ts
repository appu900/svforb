import { IsNotEmpty } from "class-validator";




export class UpdateLocationDto{


    @IsNotEmpty()
    longitude!: number;

    @IsNotEmpty()
    latitude!: number;
}