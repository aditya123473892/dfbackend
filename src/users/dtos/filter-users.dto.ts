import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { FindQueryDto } from '../../common/dtos/utils.dto';

  export class FilterUsersDto extends FindQueryDto {
    @ApiProperty({ required: false })
    @IsOptional()
    username?: string;
    
    @ApiProperty({ required: false })
    @IsOptional()
    displayname?: string;
  
    @ApiProperty({ required: false })
    @IsOptional()
    name?: string;
  
    @ApiProperty({ required: false })
    @IsOptional()
    city?: string;
  
    @ApiProperty({ required: false })
    @IsOptional()
    state?: string;
  
    @ApiProperty({ required: false })
    @IsOptional()
    country?: string;
  }
  
